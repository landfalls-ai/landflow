# RB-102: High CPU on a web node

Owner: Platform team. Matches the Grafana alert "High CPU on web-01" (and its web-02, web-03 twins).

## When
CPU above 85% for 5 minutes on a web node.

## Steps
1. Find the process: `top -o %CPU -n 1 | head -15`.
2. If it is `landflow-worker`, restart it: `systemctl restart landflow-worker` (safe at any hour; jobs resume).
3. If CPU stays above 95% for 15 minutes after the restart, page the on-call engineer and open an incident.
4. Silence the alert for 45 minutes while you work, never longer, and name yourself in the silence's comment.

## Never
Never restart `nginx` on more than one web node at a time.
