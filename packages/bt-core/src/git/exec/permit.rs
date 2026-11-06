//! The slots that cap how many short git calls run at once.

use std::sync::{Condvar, Mutex, PoisonError};

/// Short git calls alive at once, app-wide; more callers wait. Each one also costs two or three
/// pipe threads, and a burst (every restored tab asking for its baseline) must not fork dozens.
/// Long calls take no slot: a few commits or checkouts must not stall every status for minutes.
pub(super) const MAX_CONCURRENT: usize = 4;

struct Permits {
    used: Mutex<usize>,
    freed: Condvar,
}

static PERMITS: Permits = Permits { used: Mutex::new(0), freed: Condvar::new() };

/// A slot for one git process, given back on drop.
pub(super) struct Permit;

impl Permit {
    pub(super) fn acquire() -> Permit {
        let mut used = PERMITS.used.lock().unwrap_or_else(PoisonError::into_inner);
        while *used >= MAX_CONCURRENT {
            used = PERMITS.freed.wait(used).unwrap_or_else(PoisonError::into_inner);
        }
        *used += 1;
        Permit
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        *PERMITS.used.lock().unwrap_or_else(PoisonError::into_inner) -= 1;
        PERMITS.freed.notify_one();
    }
}
