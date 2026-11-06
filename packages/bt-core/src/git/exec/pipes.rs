//! Git's pipes, each served on its own thread: nothing here waits past the deadline on a child left
//! holding one.

use std::io::{self, Read, Write};
use std::sync::{mpsc, Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

/// After git is gone, how long all its pipes together may stay open: all it wrote is in them by then,
/// and only a child left behind (a hook's, a filter's) keeps them open longer.
pub(super) const PIPE_GRACE: Duration = Duration::from_secs(2);

/// Until `ended` disconnects (at once if it has) or the deadline passes.
fn wait_for_end(ended: &mpsc::Receiver<()>, deadline: Instant) {
    let _ = ended.recv_timeout(deadline.saturating_duration_since(Instant::now()));
}

/// Input written to git's stdin on its own thread, then closed.
pub(super) struct Feed {
    /// Disconnects when the writing is over.
    ended: mpsc::Receiver<()>,
}

impl Feed {
    pub(super) fn start(mut stdin: impl Write + Send + 'static, input: Vec<u8>) -> Feed {
        let (end, ended) = mpsc::channel::<()>();
        thread::spawn(move || {
            let _end = end;
            // A broken pipe means git stopped reading; its exit status tells why.
            drop(stdin.write_all(&input));
        });
        Feed { ended }
    }

    /// Call once git is gone. A writer still blocked by the deadline is left to end on its own, when
    /// whoever holds the pipe dies.
    pub(super) fn finish(self, deadline: Instant) {
        wait_for_end(&self.ended, deadline);
    }
}

/// A pipe read on its own thread, so the writer never blocks on a full one: up to a cap, then
/// drained. What arrived by the deadline of `finish` counts.
pub(super) struct Capture {
    /// The bytes, and whether there were more than the cap.
    read: Arc<Mutex<(Vec<u8>, bool)>>,
    /// Disconnects at the end of the pipe.
    ended: mpsc::Receiver<()>,
}

impl Capture {
    pub(super) fn start(mut pipe: impl Read + Send + 'static, cap: usize) -> Capture {
        let read = Arc::new(Mutex::new((Vec::new(), false)));
        let (end, ended) = mpsc::channel::<()>();
        let shared = Arc::clone(&read);
        thread::spawn(move || {
            let _end = end;
            let mut chunk = vec![0; 64 * 1024];
            loop {
                let n = match pipe.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                };
                let mut read = shared.lock().unwrap_or_else(PoisonError::into_inner);
                let room = cap.saturating_sub(read.0.len());
                read.0.extend_from_slice(&chunk[..n.min(room)]);
                read.1 |= n > room;
            }
        });
        Capture { read, ended }
    }

    /// The bytes read and whether there were more; call once git is gone.
    pub(super) fn finish(self, deadline: Instant) -> (Vec<u8>, bool) {
        wait_for_end(&self.ended, deadline);
        std::mem::take(&mut *self.read.lock().unwrap_or_else(PoisonError::into_inner))
    }
}
