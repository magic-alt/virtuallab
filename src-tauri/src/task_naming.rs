//! Readable, bounded task branches. Keep in sync with features/tasks/taskBranch.ts.
pub(crate) fn task_branch_name(title: &str, task_id: &str) -> String {
    let mut slug = String::new();
    let mut separator = false;
    for character in title.to_lowercase().chars() {
        if !character.is_alphanumeric() {
            separator = !slug.is_empty();
            continue;
        }
        if slug.len() + usize::from(separator) + character.len_utf8() > 72 {
            break;
        }
        if separator {
            slug.push('-');
        }
        slug.push(character);
        separator = false;
    }
    if slug.is_empty() {
        slug.push_str("work");
    }
    let hash = task_id.bytes().fold(0xcbf29ce484222325u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    });
    format!("task/{slug}-{:012x}", hash & 0xffffffffffff)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branches_preserve_intent_and_remain_stable_per_task() {
        let english = task_branch_name("Fix Terminal startup", "task-1");
        let chinese = task_branch_name("修复终端启动", "task-1");
        assert!(english.starts_with("task/fix-terminal-startup-"));
        assert!(chinese.starts_with("task/修复终端启动-"));
        assert_eq!(english, task_branch_name("Fix Terminal startup", "task-1"));
        assert_ne!(english, task_branch_name("Fix Terminal startup", "task-2"));
    }

    #[test]
    fn generated_names_are_bounded_literal_git_branches() {
        for title in ["../Fix\\Terminal @{bad}: [startup]? *.lock\n".to_string(), "修复终端启动".repeat(100), "🔥 ...".to_string()] {
            let name = task_branch_name(&title, "task-1");
            assert!(name.len() <= 90);
            let output = std::process::Command::new("git").args(["check-ref-format", "--branch", &name]).output().unwrap();
            assert!(output.status.success(), "{name}");
            assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), name);
        }
    }
}
