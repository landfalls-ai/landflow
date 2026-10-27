#!/bin/sh
# Throwaway SSH Git server for Landflow's source-control tests (compose profile `git`). Dev only.
#   user:  git (key login only, no passwords), repositories under /srv/git (create one over ssh:
#          ssh -p 52222 git@127.0.0.1 'git init --bare /srv/git/demo.git')
#   keys:  the public keys in /keys/*.pub are the user's authorized keys (generate them with deploy/infra/git/gen-keys.sh)
#   host:  host keys are created once and kept in the git-ssh-host volume, so a pinned host key survives restarts.
set -eu
apk add --no-cache openssh-server git >/dev/null
mkdir -p /srv/git /etc/ssh/hostkeys /home/git/.ssh
for type in ed25519 ecdsa rsa; do
  [ -f "/etc/ssh/hostkeys/ssh_host_${type}_key" ] || ssh-keygen -q -t "$type" -N '' -f "/etc/ssh/hostkeys/ssh_host_${type}_key"
done
adduser -D -h /home/git -s /bin/sh git 2>/dev/null || true
# adduser leaves the account locked ("!"), which sshd refuses even for key logins.
sed -i 's/^git:!:/git:*:/' /etc/shadow
cat /keys/*.pub > /home/git/.ssh/authorized_keys
chown -R git:git /home/git /srv/git
chmod 700 /home/git/.ssh
chmod 600 /home/git/.ssh/authorized_keys
cat > /etc/ssh/sshd_config <<'CONF'
Port 22
HostKey /etc/ssh/hostkeys/ssh_host_ed25519_key
HostKey /etc/ssh/hostkeys/ssh_host_ecdsa_key
HostKey /etc/ssh/hostkeys/ssh_host_rsa_key
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers git
AllowAgentForwarding no
AllowTcpForwarding no
X11Forwarding no
LogLevel INFO
CONF
exec /usr/sbin/sshd -D -e
