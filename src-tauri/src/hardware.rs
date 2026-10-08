//! Hardware reservation / approval *contract*, not a physical interlock.
//! The broker is deliberately not exposed as an acquisition command to agents.
//! Future hardware transports must validate a lease server-side before any I/O.
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

const MAX_TTL_MS: u64 = 600_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum PermissionLevel {
    L0, L1, L2, L3, L4,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    InspectMetadata,
    WorkspaceBuild,
    BenchRead,
    Motion,
    Power,
    Flash,
    Release,
}

impl Action {
    fn required(&self) -> PermissionLevel {
        match self {
            Self::InspectMetadata => PermissionLevel::L0,
            Self::WorkspaceBuild => PermissionLevel::L1,
            Self::BenchRead => PermissionLevel::L2,
            Self::Motion | Self::Power | Self::Flash => PermissionLevel::L3,
            Self::Release => PermissionLevel::L4,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LeaseMode {
    SharedRead,
    Exclusive,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareResource {
    id: String,
    capabilities: Vec<Action>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaseRequest {
    resource_id: String,
    workspace_root: String,
    action: Action,
    mode: LeaseMode,
    ttl_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HumanGrant {
    id: String,
    resource_id: String,
    workspace_root: String,
    max_level: PermissionLevel,
    expires_at_ms: u128,
    issuer: String,
    one_use: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HardwareLease {
    id: String,
    resource_id: String,
    workspace_root: String,
    action: Action,
    mode: LeaseMode,
    level: PermissionLevel,
    issued_at_ms: u128,
    expires_at_ms: u128,
}

#[derive(Default)]
pub struct HardwareBroker {
    resources: HashMap<String, HardwareResource>,
    leases: HashMap<String, HardwareLease>,
    used_grants: HashSet<String>,
    next_id: u64,
}

impl HardwareBroker {
    #[allow(dead_code)]
    fn register(&mut self, resource: HardwareResource) -> Result<(), String> {
        if resource.id.trim().is_empty() {
            return Err("Hardware resource ID is required.".into());
        }
        if self.resources.contains_key(&resource.id) {
            return Err("Hardware resource is already registered.".into());
        }
        self.resources.insert(resource.id.clone(), resource);
        Ok(())
    }

    #[allow(dead_code)]
    fn acquire(
        &mut self,
        request: LeaseRequest,
        grant: Option<&HumanGrant>,
        now_ms: u128,
    ) -> Result<HardwareLease, String> {
        self.reap_expired(now_ms);
        if request.workspace_root.trim().is_empty() ||
           request.ttl_ms == 0 || request.ttl_ms > MAX_TTL_MS {
            return Err("Invalid lease workspace or TTL.".into());
        }
        let resource = self.resources.get(&request.resource_id)
            .ok_or_else(|| "Unknown hardware resource.".to_string())?;
        if !resource.capabilities.contains(&request.action) {
            return Err("Requested capability is not registered on this resource.".into());
        }
        let level = request.action.required();
        if level >= PermissionLevel::L2 {
            let grant = grant.ok_or("Human approval required for bench/hardware/release.")?;
            if grant.issuer != "human" || !grant.one_use ||
                grant.resource_id != request.resource_id ||
                grant.workspace_root != request.workspace_root ||
                grant.max_level < level ||
                grant.expires_at_ms <= now_ms ||
                self.used_grants.contains(&grant.id) ||
                grant.id.trim().is_empty()
            {
                return Err("Missing, replayed, expired or insufficient human approval.".into());
            }
        }
        if request.action != Action::InspectMetadata && request.mode != LeaseMode::Exclusive {
            return Err("Non-metadata operations require an exclusive lease.".into());
        }
        if self.leases.values().any(|lease| {
            lease.resource_id == request.resource_id &&
            (lease.mode == LeaseMode::Exclusive || request.mode == LeaseMode::Exclusive)
        }) {
            return Err("Conflicting hardware lease already exists.".into());
        }
        self.next_id += 1;
        let lease = HardwareLease {
            id: format!("lease-{}", self.next_id),
            resource_id: request.resource_id,
            workspace_root: request.workspace_root,
            action: request.action,
            mode: request.mode,
            level,
            issued_at_ms: now_ms,
            expires_at_ms: now_ms.saturating_add(u128::from(request.ttl_ms)),
        };
        if let Some(grant) = grant {
            if level >= PermissionLevel::L2 {
                self.used_grants.insert(grant.id.clone());
            }
        }
        self.leases.insert(lease.id.clone(), lease.clone());
        Ok(lease)
    }

    #[allow(dead_code)]
    fn release(&mut self, lease_id: &str, workspace_root: &str) -> Result<(), String> {
        let lease = self.leases.get(lease_id).ok_or("Unknown lease.")?;
        if lease.workspace_root != workspace_root {
            return Err("Workspace cannot release another workspace's lease.".into());
        }
        self.leases.remove(lease_id);
        Ok(())
    }

    fn reap_expired(&mut self, now_ms: u128) {
        self.leases.retain(|_, lease| lease.expires_at_ms > now_ms);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resource() -> HardwareResource {
        HardwareResource {
            id: "resource-a".into(),
            capabilities: vec![Action::InspectMetadata, Action::BenchRead, Action::Motion],
        }
    }
    fn request(action: Action, mode: LeaseMode) -> LeaseRequest {
        LeaseRequest {resource_id: "resource-a".into(),workspace_root:"/repo/a".into(),
            action,mode,ttl_ms:1000}
    }
    fn human_grant() -> HumanGrant {
        HumanGrant{id:"approval-1".into(),resource_id:"resource-a".into(),
            workspace_root:"/repo/a".into(),max_level:PermissionLevel::L3,
            expires_at_ms:5000,issuer:"human".into(),one_use:true}
    }

    #[test]
    fn agents_cannot_escalate_without_independent_human_grant() {
        let mut broker=HardwareBroker::default();
        broker.register(resource()).unwrap();
        assert!(broker.acquire(request(Action::Motion,LeaseMode::Exclusive),None,1000).is_err());
        let mut fake=human_grant();
        fake.issuer="agent".into();
        assert!(broker.acquire(request(Action::Motion,LeaseMode::Exclusive),Some(&fake),1000).is_err());
        assert!(broker.leases.is_empty());
    }

    #[test]
    fn exclusive_conflict_and_lease_expiry() {
        let mut broker=HardwareBroker::default();
        broker.register(resource()).unwrap();
        let first=broker.acquire(request(Action::InspectMetadata,LeaseMode::SharedRead),None,1000).unwrap();
        assert!(broker.acquire(request(Action::InspectMetadata,LeaseMode::Exclusive),None,1200).is_err());
        broker.reap_expired(2000);
        assert!(!broker.leases.contains_key(&first.id));
        assert!(broker.acquire(request(Action::InspectMetadata,LeaseMode::Exclusive),None,2000).is_ok());
    }

    #[test]
    fn grant_is_scoped_one_use_and_cannot_be_replayed() {
        let mut broker=HardwareBroker::default();
        broker.register(resource()).unwrap();
        let grant=human_grant();
        let lease=broker.acquire(request(Action::Motion,LeaseMode::Exclusive),Some(&grant),1000).unwrap();
        assert!(broker.release(&lease.id,"/other").is_err());
        broker.release(&lease.id,"/repo/a").unwrap();
        assert!(broker.acquire(request(Action::Motion,LeaseMode::Exclusive),Some(&grant),1500).is_err());
    }

    #[test]
    fn approval_level_is_not_self_declared_by_request() {
        let mut broker=HardwareBroker::default();
        broker.register(resource()).unwrap();
        let mut grant=human_grant();
        grant.max_level=PermissionLevel::L2;
        assert!(broker.acquire(request(Action::Motion,LeaseMode::Exclusive),Some(&grant),1000).is_err());
    }
}
