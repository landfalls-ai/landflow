# RB-104: TLS certificate about to expire

Owner: Platform team.

## When
A certificate expires in fewer than 19 days (we renew at 19 days, not at 30).

## Steps
1. Renew it: `certbot renew --cert-name web-01.landflow.test` (change the name for other hosts).
2. Reload, do not restart: `systemctl reload nginx`.
3. Check the new expiry date: `echo | openssl s_client -connect web-01.landflow.test:443 2>/dev/null | openssl x509 -noout -enddate`.

## Never
Never copy a private key off the host it was made on.
