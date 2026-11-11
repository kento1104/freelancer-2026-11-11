# Hosting setup

## Configure and run the server

The server targets Node.js 24.x; the `engines.node` setting in `package.json`
keeps deployment platforms from selecting an incompatible newer runtime.

1. Copy `.env.example` to `.env` and set `SHEET_ID` and the Google Sheets credentials.
   You can use a credentials file, a JSON value in `GOOGLE_SERVICE_ACCOUNT_JSON`,
   or the cloud host's attached service account (leave both credential variables
   empty for attached credentials). Gmail token refresh, if used, also requires
   `GMAIL_REFRESH_TOKEN`, `GMAIL_CLIENT_ID`, and `GMAIL_CLIENT_SECRET`.
2. Share the spreadsheet with the service account and ensure the `Profile` sheet has
   `username`, `aboutme`, comma-separated `skills`, `prompt` (or `script`),
   `conclusion_AI_key`, and
   `Gemini_API_key` columns. The conclusion key is used only for project-feasibility
   scoring; the Gemini API key is used for proposal generation.
   The `API_projects` sheet must include a `timestamp` or `timeStamp` column so the
   server can enforce the 24-hour project age limit.
3. Create a `My Events` sheet with these headers in row 1:
   `Date/Time`, `Project ID`, `Project URL`, `Account` (or `username`; the
   currently used misspelling `acccount` is also accepted),
   `Bid Status`, `Status Reason`, `Proposal`. The service account needs permission
   to append rows.
4. Install dependencies with `npm ci` and start with `npm start`. The server binds to
   `0.0.0.0` and uses the platform-provided `PORT` by default.
5. Configure `CORS_ORIGINS` for the extension origins if you do not want the default
   wildcard. Set this variable in the hosting dashboard when `.env` is unavailable.
6. Open `http://localhost:5000/` to use the project-forwarding interface served by the
   local server. The extension popup continues to provide the same controls.

Do not commit `.env` or service-account credentials. The server does not load a
service-account file from the repository by default; configure
`GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_SERVICE_ACCOUNT_JSON`, or application
default credentials instead. Gemini API keys are not server environment variables;
the server looks them up by username from the `Profile` sheet.
The proposal-writing prompt comes from the selected profile row's `prompt` column
(`script` is also accepted); the feasibility evaluator uses `conclusion_AI_key`, and
proposal generation uses `Gemini_API_key`.

Plan-bid filters are configured in the Auto Bid extension's options page and sent with
each `/need_project` request. The defaults preserve the existing country, verification,
and budget rules. To use additional verification checks, include their corresponding
columns in `API_projects` (for example, `Identity_verified`, `Email_verified`,
`Profile_completed`, or `Phone_verified`); the server fills these columns when it
saves incoming projects.

The Freelancer Project Forwarder extension keeps its popup as the user interface. The
Fetch and send button makes one request to `/fetch_projects`. Start auto repeat makes
one request to `/auto_fetch/start`; the server then polls Freelancer every 10 seconds
and saves projects through the same processing path used by `/add_detail`. Stop makes
one request to `/auto_fetch/stop`. Repeating requests run only on the server and stop
when the server process restarts. The extension does not request Freelancer directly.

The Auto Bid extension compares the configured profile's comma-separated skills with
project `jobs[].name` values, then asks the model configured in the server to score
feasibility from 0 to 100 in increments of 10 using `conclusion_AI_key`. It generates a
proposal when the score meets or exceeds the extension's configured threshold,
using the profile's `aboutme`, `skills`, and `prompt` with `Gemini_API_key`. The
minimum required exact skill matches and feasibility threshold are configurable in
the Auto Bid extension options. Projects with missing or unsupported currency codes
are marked `Bad_Currency` and skipped instead of aborting the fetch or selection cycle.
Bid outcomes and filter skips are written to `My Events`, not `Events`. `Bid Status`
is `Yes` for a confirmed successful bid, `Skip` for server-side eligibility filters,
and `Error` for an unsuccessful or unconfirmed extension bid attempt. `Date/Time` is
the server-generated timestamp registered immediately before the extension opens
the project to place the bid. `Proposal` contains the complete proposal text for
attempted bids and is blank for projects skipped by filters. Registration times and
event times are formatted in the `Asia/Tokyo` time zone. Project registrations older
than 24 elapsed hours, plus rows with missing, invalid, or future registration times,
are recorded as `Skip` and never sent to feasibility or proposal generation. This
rule also applies to a pending project restored after a server restart.

## Point both extensions at the hosted server

In each extension folder, edit `server-config.js` and set `SERVER_BASE_URL` to the
HTTPS origin of the deployed server (without an endpoint path). Then replace the
localhost entry in that extension's `manifest.json` `host_permissions` with the
matching HTTPS origin pattern, for example `https://api.example.com/*`. Reload or
repackage the extension after changing its manifest.

The server address has one source file per independently installable extension;
the manifest permission must match that origin for Chrome to allow the requests.
