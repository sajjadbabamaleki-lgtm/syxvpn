# Sign-in codes by email

The app asks for three things: an address, a password, and a six-digit code
sent to that address. The code is what lets the control plane settle, on its
own, whether the person in front of it is signing in or opening an account —
a question nobody typing can be expected to answer, and one that must not be
asked out loud, because asking tells anyone with a list of addresses which of
them are customers here.

Nothing is sent until a relay is configured. `GET /api/v1/shop/config` reports
`emailCodes: false` while that is so, and `POST /api/v1/shop/auth/code` refuses
rather than opening a code field for a code nobody is sending.

## Configure a relay

Five settings in `.env`, then one deploy:

```sh
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=you@gmail.com
SMTP_PASS=abcd efgh ijkl mnop
MAIL_FROM=SYX VPN <you@gmail.com>
```

Port 465 is implicit TLS and 587 is STARTTLS; both are encrypted and plaintext
SMTP is not offered at all. `MAIL_FROM` may carry a display name.

With a Gmail account, `SMTP_PASS` is an **app password** from
<https://myaccount.google.com/apppasswords>, not the account password — Google
refuses the account password on SMTP, and two-step verification has to be on
before app passwords exist at all. Gmail also rewrites `From` to the account's
own address, so send as the account you authenticated with.

Any ordinary relay works the same way: Fastmail, Zoho, Brevo, Postmark,
Mailgun, or a company mail server.

## What the codes do

- Six digits, ten minutes, five wrong guesses, one use.
- One live code per address. A resend replaces the previous one, and the one it
  replaced stops working immediately.
- A resend is refused for 45 seconds after the last one, so the button in the
  app is not a free mailer for whoever points a script at it.
- Only the SHA-256 of the code is stored. A backup of the database is not a
  list of live codes.

## Closing the older way in

`/register` and `/login` predate this and accept a request with no code, which
is how the web storefront still signs people in. A code they *do* carry is
always verified. Once nothing in the field signs in without one, set
`AUTH_REQUIRE_EMAIL_CODE=true` and those two routes start refusing a request
that carries none.

## Checking it works

```sh
curl -s https://syxvpn.pro/api/v1/shop/config | grep -o '"emailCodes":[a-z]*'
curl -s -X POST https://syxvpn.pro/api/v1/shop/auth/code \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com"}'
```

The second prints `{"sent":true,...}` and the message arrives within seconds.
When the relay refuses, the reply is a 500 with a short reason and the API log
carries the relay's own words under `sign-in code could not be sent`.
