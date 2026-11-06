//! Reading git's output pipes.

use std::io::{self, Read};
use std::sync::{mpsc, Arc, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

/// After git is gone, how long its pipes may stay open: all it wrote is in them by then, and only a
/// child left behind (a hook's, a filter's) keeps them open longer.
const PIPE_GRACE: Duration = Duration::from_secs(2);

/// A pipe read on its own thread, so the writer never blocks on a full one: up to a cap, then
/// drained. Finishing never waits on a child left holding the pipe; what arrived by then counts.
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
    pub(super) fn finish(self) -> (Vec<u8>, bool) {
        let _ = self.ended.recv_timeout(PIPE_GRACE);
        std::mem::take(&mut *self.read.lock().unwrap_or_else(PoisonError::into_inner))
    }
}
