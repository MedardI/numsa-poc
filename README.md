# NUM website with a document approval backend

A modernised rebuild of the num.org.za (National Union of Mineworkers) home page, plus a small backend where staff upload documents.
Once an approver approves a document, it shows up on the home page in **Publications** (`/#documents`).
Nothing else has to happen.

## Run it

Requires Node 22.13 or newer (it uses the built-in `node:sqlite`). With nvm: `nvm use` (see `.nvmrc`).

```bash
npm install
cp .env.example .env   # then set ADMIN_EMAIL / ADMIN_PASSWORD
npm start
```

- Website: http://localhost:3000
- Document portal: http://localhost:3000/admin

The first time it starts with an empty database, the server creates an **approver** account from
`ADMIN_EMAIL` / `ADMIN_PASSWORD`. If `ADMIN_PASSWORD` is not set, it generates one and prints it in the console.

## How the workflow works

| Status | Who sets it | Shown on the website? |
| --- | --- | --- |
| `pending` | Anyone who uploads | No |
| `approved` | An approver clicks **Approve & publish** | **Yes, straight away** |
| `rejected` | An approver rejects it (a reason is required) | No. The uploader can edit and resubmit |
| `archived` (shown as "Unpublished") | An approver takes a live document down | No. It can be republished |

Roles:
- **Editor**: uploads documents, and edits or deletes their own documents until they are published.
- **Approver**: everything an editor can do, plus approve, reject, unpublish and republish, add or remove users,
  and read messages sent through the home page's **Get In Touch** form (portal → Messages).

Set `ALLOW_SELF_APPROVAL=false` if a second approver must approve documents an approver uploaded.

Files for documents that are pending, rejected or unpublished can't be downloaded publicly
(`/documents/:id/download` returns 404). Signed-in staff can preview them from the portal.

## What's in here

```
server.js           Express app: public API, auth, admin API
db.js               SQLite schema, password hashing, first-run admin
public/index.html   NUM home page (news, publications, videos, contact form, join)
public/js/site.js   News carousel, video players, contact form, document feed (reads /api/documents)
public/admin.html   Document portal (login, review queue, upload, messages, users)
public/js/admin.js
data/               Created on first run: numsa.db and uploads/ (not in git)
```

### API

Public:
- `GET /api/documents?category=&q=&limit=&offset=` lists approved documents only
- `GET /api/categories`
- `GET /documents/:id/download[?inline=1]` downloads a file (approved documents only)
- `POST /api/contact` (`name`, `surname`, `email`, `message`) stores a Get In Touch message; 5 per hour per IP

Staff (session cookie; state-changing calls need the `X-Requested-With: fetch` header):
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `GET /api/admin/documents?status=`, `POST /api/admin/documents` (multipart: `file`, `title`, `category`, `description`)
- `PATCH /api/admin/documents/:id`, `DELETE /api/admin/documents/:id`
- `POST /api/admin/documents/:id/approve | reject | unpublish | resubmit`
- `GET /api/admin/documents/:id/file` previews any document
- `GET /api/admin/messages`, `POST /api/admin/messages/:id/read`, `DELETE /api/admin/messages/:id`
- `GET/POST /api/admin/users`, `DELETE /api/admin/users/:id`, `POST /api/admin/users/:id/password`

Allowed file types: pdf, doc(x), xls(x), ppt(x), odt, txt, csv, jpg, png. The size limit is 25 MB (`MAX_UPLOAD_MB`).

## Notes for production

- Serve it over HTTPS behind a reverse proxy and set `NODE_ENV=production`, which marks the session cookie `Secure`.
- Back up the `data/` folder. It holds both the database and the uploaded files.
- Only the home page works. Menu items for other pages either link to sections of the home page,
  open a filtered document list (for example Careers or Media Statements), or go nowhere (`#`).
  News stories, Join NUM and View More link out to the matching pages on num.org.za.
- Images and the logo were copied from num.org.za into `public/assets/num/`. Video thumbnails load from YouTube,
  and the player only loads (from youtube-nocookie.com) when a visitor presses play.
