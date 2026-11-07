# Browser QA

End-to-end checks run in a real Chromium against throwaway demo servers (in-memory data, nothing touches production).

```
pip install -r qa/requirements.txt && playwright install chromium
bash qa/run.sh                    # today's reads
CORE_READS=on bash qa/run.sh      # phase 2: permanent-project reads
```

| Check | What it proves |
|---|---|
| menu routing | every sidebar item opens its own page (both account types) |
| every screen | each page loads with no JavaScript or server errors (owner, subscriber, GC) |
| dead controls | every visible button/link has a working action — no decorative controls (incl. all project-profile tabs) |
| plan room + addenda | upload → sheet index → addendum → bidder blocked until acknowledged → bid → planholder list |
| bid leveling + prequalification | invite → will bid → bid → leveling table with insurance/license flags → approve |
| drawing takeoff | real PDF rendered; area of a known outline = 6,400 SF, wall = 80 LF; → estimate |
| AI analysis → estimate → bid | confirmed reading → priced lines with sources → bid submitted and locked |

The demo servers raise the sign-in rate limit (`LOGIN_RATE_LIMIT=1000`) because the suite signs in many times;
production keeps the default of 10 per 15 minutes.
