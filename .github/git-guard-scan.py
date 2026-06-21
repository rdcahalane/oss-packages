#!/usr/bin/env python3
"""git-guard — blocks commits/pushes that introduce injection/backdoor patterns or secrets.

Created after an autonomous agent was prompt-injected and committed an
eval(fetch(atob(process.env.AUTH_API_KEY))) RCE backdoor + a planted .env.
This is the structural gate: catch the malicious OUTPUT regardless of how the
agent was fooled.

Modes:
  precommit  — scans staged changes
  prepush    — scans commits being pushed (reads git's stdin: <local_ref> <local_sha> <remote_ref> <remote_sha>)

Override (use sparingly, for genuinely legit cases):
  - inline comment `git-guard:allow` on the offending line
  - env GITGUARD_ALLOW=1 for a whole commit/push
"""
import os, re, subprocess, sys

# HIGH-severity code-execution patterns — the backdoor's building blocks.
CODE_PATTERNS = [
    (re.compile(r'\beval\s*\('), "eval() — dynamic code execution"),
    (re.compile(r'\bnew\s+Function\s*\('), "new Function() — dynamic code execution"),
    (re.compile(r'atob\s*\(\s*process\.env'), "atob(process.env…) — decoding an env var to run it (the backdoor pattern)"),
    (re.compile(r'(child_process|execSync|exec)\s*[\.\(][\s\S]{0,60}\$\{'), "shell exec of an interpolated value"),
    (re.compile(r'(?:require|import)\s*\(\s*[`"\']?\s*\$\{'), "dynamic require/import of an interpolated value"),
    (re.compile(r'(fetch|axios|node-fetch)[\s\S]{0,120}\beval\s*\('), "fetch result passed to eval — remote code execution"),
]
SECRET_PATTERNS = [
    (re.compile(r'sk-or-v1-[A-Za-z0-9]{20,}'), "OpenRouter API key"),
    (re.compile(r'sk-[A-Za-z0-9]{20,}'), "OpenAI-style API key"),
    (re.compile(r'AIza[0-9A-Za-z_\-]{20,}'), "Google API key"),
    (re.compile(r'ghp_[A-Za-z0-9]{20,}'), "GitHub personal access token"),
    (re.compile(r'xox[baprs]-[A-Za-z0-9-]{10,}'), "Slack token"),
    (re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'), "private key"),
]
# Long base64 blob assigned to a string — how the payload URL was hidden.
BASE64_BLOB = re.compile(r'["\'][A-Za-z0-9+/]{44,}={0,2}["\']')
ALLOW_INLINE = "git-guard:allow"
SKIP_FILES = re.compile(r'(^|/)(\.env\.example|package-lock\.json|.*\.lock|.*\.(png|jpg|jpeg|gif|pdf|woff2?|map))$')
# The scanner must not flag its own pattern-definition strings. Integrity of the
# scanner files themselves is covered by branch protection + review, not self-scan.
SELF_SKIP = re.compile(r'(^|/)(git-guard-scan\.py|\.config/git-guard/scan\.py)$')

def sh(args):
    return subprocess.run(args, capture_output=True, text=True).stdout

def staged_files():
    out = sh(["git", "diff", "--cached", "--name-only", "--diff-filter=ACM"])
    return [f for f in out.splitlines() if f.strip()]

def pushed_files():
    files = set()
    for line in sys.stdin:
        parts = line.split()
        if len(parts) < 4: continue
        local_sha, remote_sha = parts[1], parts[3]
        if set(local_sha) == {"0"}: continue  # branch deletion
        rng = f"{local_sha}" if set(remote_sha) == {"0"} else f"{remote_sha}..{local_sha}"
        out = sh(["git", "diff", "--name-only", "--diff-filter=ACM", rng]) if ".." in rng \
              else sh(["git", "show", "--name-only", "--diff-filter=ACM", "--pretty=format:", rng])
        files.update(f for f in out.splitlines() if f.strip())
    return sorted(files)

def file_content(path, mode):
    if mode == "precommit":
        return sh(["git", "show", f":{path}"])  # staged version
    try:
        with open(path, "r", errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""

def scan_text(path, text):
    findings = []
    for i, line in enumerate(text.splitlines(), 1):
        if ALLOW_INLINE in line:
            continue
        for rx, desc in CODE_PATTERNS + SECRET_PATTERNS:
            if rx.search(line):
                findings.append((i, desc, line.strip()[:120]))
        if BASE64_BLOB.search(line) and re.search(r'(KEY|TOKEN|SECRET|URL|PAYLOAD|AUTH)', line, re.I):
            findings.append((i, "long base64 blob in a key/url/token var (possible hidden payload)", line.strip()[:120]))
    return findings

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "precommit"
    if os.environ.get("GITGUARD_ALLOW") == "1":
        print("git-guard: bypassed via GITGUARD_ALLOW=1", file=sys.stderr)
        return 0
    if mode == "files":
        files = [f for f in sys.argv[2:] if f.strip()]
    else:
        files = staged_files() if mode == "precommit" else pushed_files()
    blocked = []
    for f in files:
        base = f.split("/")[-1]
        if base == ".env" or re.match(r'\.env($|\.local|\.prod)', base):
            blocked.append((f, [(0, "committing a .env file (secrets do not belong in git)", base)]))
            continue
        if SKIP_FILES.search(f) or SELF_SKIP.search(f):
            continue
        findings = scan_text(f, file_content(f, mode))
        if findings:
            blocked.append((f, findings))
    if not blocked:
        return 0
    print("\n\033[31m✗ git-guard BLOCKED this " + mode.replace("pre", "pre-") + "\033[0m — injection/secret patterns detected:\n", file=sys.stderr)
    for f, findings in blocked:
        print(f"  {f}", file=sys.stderr)
        for ln, desc, snippet in findings:
            loc = f"L{ln}: " if ln else ""
            print(f"    • {loc}{desc}", file=sys.stderr)
            if snippet: print(f"        {snippet}", file=sys.stderr)
    print("\n  If a finding is genuinely legitimate: add `git-guard:allow` on that line,", file=sys.stderr)
    print("  or run with GITGUARD_ALLOW=1. Otherwise — do not bypass; this is the backdoor gate.\n", file=sys.stderr)
    return 1

if __name__ == "__main__":
    sys.exit(main())
