//! An agent's environment: the user's login-shell environment (a GUI app on macOS starts with a
//! minimal `PATH`, so `npx` wouldn't be found), minus variables that would redirect git, plus the
//! agent's own `env` with `${env:NAME}` and `${keychain:name}` resolved. Resolved values are
//! secrets: they go to the agent process only, never to logs, IPC or files.

use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

/// Keychain service under which `${keychain:name}` entries are looked up (account = `name`).
pub const KEYCHAIN_SERVICE: &str = "brama";

/// The environment of a login shell, read once; the app's own environment when that fails.
/// Blocking (runs the shell): call off the async runtime.
pub fn login_shell_env() -> &'static HashMap<String, String> {
    static ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
    ENV.get_or_init(|| match read_login_shell_env() {
        Ok(env) => {
            tracing::debug!(vars = env.len(), "read the login shell's environment");
            env
        }
        Err(e) => {
            tracing::info!("using the app's environment for agents: {e}");
            std::env::vars().collect()
        }
    })
}

#[cfg(unix)]
fn read_login_shell_env() -> Result<HashMap<String, String>, String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const MARKER: &str = "__BRAMA_ENV_7f3a__";
    const TIMEOUT: Duration = Duration::from_secs(10);
    let shell = crate::util::default_shell().to_string_lossy().into_owned();
    // Interactive too: version managers (nvm, fnm, asdf) usually set PATH in the rc file.
    let script = format!("printf '%s' {MARKER}; env -0; printf '%s' {MARKER}");
    let mut child = Command::new(&shell)
        .args(["-l", "-i", "-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("{shell}: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{shell} took over {}s", TIMEOUT.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => return Err(e.to_string()),
        }
    }
    let out = reader.join().map_err(|_| "reader panicked")?;
    let out = String::from_utf8_lossy(&out);
    let body = out.split(MARKER).nth(1).ok_or("no environment in the shell's output")?;
    let env: HashMap<String, String> = body
        .split('\0')
        .filter_map(|pair| pair.split_once('='))
        .filter(|(key, _)| !key.is_empty())
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
    if env.contains_key("PATH") {
        Ok(env)
    } else {
        Err("the shell's environment has no PATH".to_owned())
    }
}

#[cfg(not(unix))]
fn read_login_shell_env() -> Result<HashMap<String, String>, String> {
    Ok(std::env::vars().collect())
}

/// Where `${keychain:name}` values come from; the OS keychain in the app, a map in tests.
pub trait SecretStore {
    fn get(&self, name: &str) -> Result<String, String>;
}

pub struct OsKeychain;

impl SecretStore for OsKeychain {
    fn get(&self, name: &str) -> Result<String, String> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, name).map_err(|e| e.to_string())?;
        entry.get_password().map_err(|e| match e {
            keyring::Error::NoEntry => format!("no keychain item \"{name}\" (service \"{KEYCHAIN_SERVICE}\")"),
            other => format!("keychain item \"{name}\": {other}"),
        })
    }
}

/// The agent process's whole environment: `base` without `scrubbed`, then the agent's `env` with
/// placeholders resolved against `base` and `secrets`. Errors name the variable, never a value.
pub fn agent_env(
    base: &HashMap<String, String>,
    scrubbed: &[&str],
    agent_env: &BTreeMap<String, String>,
    secrets: &dyn SecretStore,
) -> Result<Vec<(String, String)>, String> {
    let mut env: BTreeMap<String, String> =
        base.iter().filter(|(k, _)| !scrubbed.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    for (key, template) in agent_env {
        let value = resolve(template, base, secrets).map_err(|e| format!("env {key}: {e}"))?;
        env.insert(key.clone(), value);
    }
    Ok(env.into_iter().collect())
}

/// Expands `${env:NAME}` and `${keychain:name}` in `template`; other text is kept as is.
fn resolve(template: &str, base: &HashMap<String, String>, secrets: &dyn SecretStore) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after.find('}').ok_or("unclosed \"${\"")?;
        let (kind, name) = after[..end].split_once(':').ok_or_else(|| format!("\"${{{}}}\": expected env: or keychain:", &after[..end]))?;
        match kind {
            "env" => out.push_str(base.get(name).ok_or_else(|| format!("${{env:{name}}} is not set"))?),
            "keychain" => out.push_str(&secrets.get(name)?),
            other => return Err(format!("unknown placeholder kind \"{other}\"")),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake;

    impl SecretStore for Fake {
        fn get(&self, name: &str) -> Result<String, String> {
            match name {
                "openai" => Ok("sk-secret".to_owned()),
                _ => Err(format!("no keychain item \"{name}\"")),
            }
        }
    }

    fn base() -> HashMap<String, String> {
        HashMap::from([
            ("PATH".to_owned(), "/opt/homebrew/bin:/usr/bin".to_owned()),
            ("HOME".to_owned(), "/Users/me".to_owned()),
            ("GIT_DIR".to_owned(), "/elsewhere/.git".to_owned()),
        ])
    }

    #[test]
    fn resolves_placeholders_and_scrubs_git_redirects() {
        let agent = BTreeMap::from([
            ("OPENAI_API_KEY".to_owned(), "${keychain:openai}".to_owned()),
            ("DATA".to_owned(), "${env:HOME}/data".to_owned()),
            ("PLAIN".to_owned(), "x".to_owned()),
        ]);
        let env: HashMap<_, _> = agent_env(&base(), &["GIT_DIR"], &agent, &Fake).unwrap().into_iter().collect();
        assert_eq!(env["OPENAI_API_KEY"], "sk-secret");
        assert_eq!(env["DATA"], "/Users/me/data");
        assert_eq!(env["PLAIN"], "x");
        assert_eq!(env["PATH"], "/opt/homebrew/bin:/usr/bin");
        assert!(!env.contains_key("GIT_DIR"));
    }

    #[test]
    fn errors_name_the_variable_not_a_value() {
        let missing = BTreeMap::from([("TOKEN".to_owned(), "${keychain:nope}".to_owned())]);
        assert_eq!(agent_env(&base(), &[], &missing, &Fake).unwrap_err(), "env TOKEN: no keychain item \"nope\"");
        let unset = BTreeMap::from([("X".to_owned(), "${env:UNSET}".to_owned())]);
        assert_eq!(agent_env(&base(), &[], &unset, &Fake).unwrap_err(), "env X: ${env:UNSET} is not set");
        let bad = BTreeMap::from([("X".to_owned(), "${file:a}".to_owned())]);
        assert!(agent_env(&base(), &[], &bad, &Fake).unwrap_err().contains("unknown placeholder"));
        let open = BTreeMap::from([("X".to_owned(), "${env:HOME".to_owned())]);
        assert!(agent_env(&base(), &[], &open, &Fake).unwrap_err().contains("unclosed"));
    }

    #[cfg(unix)]
    #[test]
    fn login_shell_env_has_a_path() {
        assert!(login_shell_env().contains_key("PATH"));
    }
}
