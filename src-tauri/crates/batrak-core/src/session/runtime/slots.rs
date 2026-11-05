//! Turn slots: a project's local sessions share its checkout, so their turns take it one at a
//! time, first come, first served. Only a turn holds the slot, never an idle session.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

use super::lock;

/// Every project's slot, by canonical project path. Cheap to clone.
#[derive(Clone, Default)]
pub(super) struct TurnSlots {
    slots: Arc<Mutex<HashMap<PathBuf, Slot>>>,
}

#[derive(Default)]
struct Slot {
    holder: Option<String>,
    /// Waiting turns in order, each woken through its own `Notify` (which keeps a wake-up that
    /// comes before anyone waits).
    queue: VecDeque<(String, Arc<Notify>)>,
}

/// What a turn gets from [`TurnSlots::enter`].
pub(super) enum Entry {
    Granted(TurnPermit),
    /// Another session's turn holds the slot (`holder`).
    Queued { holder: String, ticket: Ticket },
}

/// What a queued turn hears next ([`Ticket::next`]).
pub(super) enum Turn {
    Granted(TurnPermit),
    /// Still queued, now behind this session's turn.
    Behind(String),
    /// It left the queue ([`TurnSlots::leave`]).
    Left,
}

/// The slot, held until dropped; the next queued turn gets it then.
pub(super) struct TurnPermit {
    slots: TurnSlots,
    project: PathBuf,
    id: String,
}

/// A place in the queue; dropped unused, it leaves the queue (or hands on the slot it got).
pub(super) struct Ticket {
    slots: TurnSlots,
    project: PathBuf,
    id: String,
    notify: Arc<Notify>,
    holder: String,
    /// Turned into a permit.
    used: bool,
}

impl TurnSlots {
    /// Takes the project's slot for session `id`'s turn, or queues it behind the others. Claimed
    /// under one lock, so two turns never both get it.
    pub(super) fn enter(&self, project: &Path, id: &str) -> Entry {
        let mut slots = lock(&self.slots);
        let slot = slots.entry(project.to_path_buf()).or_default();
        let Some(holder) = slot.holder.clone() else {
            slot.holder = Some(id.to_owned());
            return Entry::Granted(TurnPermit { slots: self.clone(), project: project.to_path_buf(), id: id.to_owned() });
        };
        let notify = Arc::new(Notify::new());
        slot.queue.push_back((id.to_owned(), Arc::clone(&notify)));
        let ticket = Ticket {
            slots: self.clone(),
            project: project.to_path_buf(),
            id: id.to_owned(),
            notify,
            holder: holder.clone(),
            used: false,
        };
        Entry::Queued { holder, ticket }
    }

    /// Drops session `id`'s queued turn; its ticket then hears [`Turn::Left`]. `false` when it
    /// wasn't queued (a holder keeps the slot until its permit drops).
    pub(super) fn leave(&self, project: &Path, id: &str) -> bool {
        let mut slots = lock(&self.slots);
        let Some(slot) = slots.get_mut(project) else { return false };
        let Some(at) = slot.queue.iter().position(|(queued, _)| queued == id) else { return false };
        if let Some((_, notify)) = slot.queue.remove(at) {
            notify.notify_one();
        }
        true
    }

    /// Hands `id`'s slot to the next queued turn, if `id` holds it; the others hear who holds it now.
    fn release(&self, project: &Path, id: &str) {
        let mut slots = lock(&self.slots);
        let Some(slot) = slots.get_mut(project) else { return };
        if slot.holder.as_deref() != Some(id) {
            return;
        }
        let Some((next, woken)) = slot.queue.pop_front() else {
            slots.remove(project);
            return;
        };
        slot.holder = Some(next);
        woken.notify_one();
        for (_, behind) in &slot.queue {
            behind.notify_one();
        }
    }
}

impl Ticket {
    /// Waits until the slot is this turn's, its holder changes, or it left the queue.
    pub(super) async fn next(&mut self) -> Turn {
        loop {
            self.notify.notified().await;
            let slots = lock(&self.slots.slots);
            let Some(slot) = slots.get(&self.project) else { return Turn::Left };
            let holder = slot.holder.clone().unwrap_or_default();
            if holder == self.id {
                drop(slots);
                self.used = true;
                return Turn::Granted(TurnPermit { slots: self.slots.clone(), project: self.project.clone(), id: self.id.clone() });
            }
            if !slot.queue.iter().any(|(queued, _)| *queued == self.id) {
                return Turn::Left;
            }
            if holder != self.holder {
                self.holder.clone_from(&holder);
                return Turn::Behind(holder);
            }
        }
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        if !self.used {
            self.slots.leave(&self.project, &self.id);
            self.slots.release(&self.project, &self.id);
        }
    }
}

impl Drop for TurnPermit {
    fn drop(&mut self) {
        self.slots.release(&self.project, &self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn granted(entry: Entry) -> TurnPermit {
        match entry {
            Entry::Granted(permit) => permit,
            Entry::Queued { holder, .. } => panic!("queued behind {holder}"),
        }
    }

    fn queued(entry: Entry) -> (String, Ticket) {
        match entry {
            Entry::Granted(_) => panic!("granted"),
            Entry::Queued { holder, ticket } => (holder, ticket),
        }
    }

    async fn turn(ticket: &mut Ticket) -> Option<TurnPermit> {
        loop {
            match ticket.next().await {
                Turn::Granted(permit) => return Some(permit),
                Turn::Behind(_) => {}
                Turn::Left => return None,
            }
        }
    }

    #[tokio::test]
    async fn turns_take_the_slot_in_order_and_projects_dont_share_one() {
        let slots = TurnSlots::default();
        let (p, other) = (Path::new("/p"), Path::new("/other"));
        let a = granted(slots.enter(p, "a"));
        let _elsewhere = granted(slots.enter(other, "x"));
        let (holder, mut b) = queued(slots.enter(p, "b"));
        assert_eq!(holder, "a");
        let (_, mut c) = queued(slots.enter(p, "c"));
        drop(a);
        let b = turn(&mut b).await.expect("b is next");
        assert!(matches!(c.next().await, Turn::Behind(h) if h == "b"), "c hears b holds it now");
        drop(b);
        let c = turn(&mut c).await.expect("then c");
        drop(c);
        assert!(!lock(&slots.slots).contains_key(p), "nothing left behind");
        granted(slots.enter(p, "d"));
    }

    #[tokio::test]
    async fn a_turn_that_leaves_the_queue_is_skipped() {
        let slots = TurnSlots::default();
        let p = Path::new("/p");
        let a = granted(slots.enter(p, "a"));
        let (_, mut b) = queued(slots.enter(p, "b"));
        let (_, mut c) = queued(slots.enter(p, "c"));
        assert!(slots.leave(p, "b"));
        assert!(!slots.leave(p, "b"), "once");
        assert!(!slots.leave(p, "a"), "a holder keeps it until its permit drops");
        assert!(turn(&mut b).await.is_none());
        drop(a);
        assert!(turn(&mut c).await.is_some());
    }

    #[tokio::test]
    async fn a_ticket_dropped_unused_neither_holds_nor_blocks_the_slot() {
        let slots = TurnSlots::default();
        let p = Path::new("/p");
        let a = granted(slots.enter(p, "a"));
        let (_, b) = queued(slots.enter(p, "b"));
        let (_, mut c) = queued(slots.enter(p, "c"));
        drop(a);
        drop(b);
        assert!(turn(&mut c).await.is_some(), "b's slot went on to c");
    }
}
