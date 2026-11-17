# RB-103: SSH brute force against a host

Owner: Security team. Matches Wazuh rules 5710, 5712 and 5720.

## When
More than 20 failed SSH logins from one address within 60 seconds.

## Steps
1. Block the address at the host firewall: `ufw deny from <address> to any port 22`.
2. Add the address to the shared blocklist `security/blocklist.txt` with the alert's rule number.
3. If the target user was `root`, check that `PermitRootLogin no` is still set in `/etc/ssh/sshd_config`.
4. Email the summary to oncall@landflow.test within 20 minutes.

## Never
Never unblock an address the same day it was blocked.
