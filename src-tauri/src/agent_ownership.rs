//! Cross-harness exclusive workspace ownership. Process ownership is not a hardware lease.
use std::{collections::HashMap, sync::{Arc, Mutex}};

#[derive(Clone, Default)]
pub struct AgentOwnership(Arc<Mutex<HashMap<String, String>>>);
fn key(path: &str) -> String {
    crate::workspace_identity::key(path)
}
impl AgentOwnership {
    pub fn claim(&self, root: &str, kind: &str) -> Result<(), String> {
        let mut owners = self.0.lock().map_err(|_| "Agent owner lock poisoned")?;
        let key = key(root);
        if let Some(current) = owners.get(&key) {
            if current != kind {
                return Err(format!("Workspace already owned by {current}; stop that runtime before attaching {kind}."));
            }
        }
        owners.insert(key, kind.to_string());
        Ok(())
    }
    pub fn release(&self, root: &str, kind: &str) {
        if let Ok(mut owners) = self.0.lock() {
            let key = key(root);
            if owners.get(&key).is_some_and(|value| value == kind) {
                owners.remove(&key);
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn only_one_harness_can_own_a_workspace() {
        let owner = AgentOwnership::default();
        owner.claim("C:\\Code\\Demo", "codex").unwrap();
        assert!(owner.claim("c:/code/demo/", "claude").is_err());
        owner.release("C:\\Code\\Demo", "claude");
        assert!(owner.claim("c:/code/demo", "opencode").is_err());
        owner.release("c:/code/demo", "codex");
        owner.claim("c:/code/demo", "opencode").unwrap();
    }
}
