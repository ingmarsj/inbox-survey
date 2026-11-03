// Runtime settings for the front end. `backend` says where the answers go:
//
//   'server'    the Node server in this repository (SQLite)            <- this default
//   'demo'      an in-browser fake that stores nothing (GitHub Pages demo, scripts/build-pages.mjs)
//   'supabase'  Supabase functions, using only the publishable key     (scripts/build-why.mjs)
//
// The build scripts overwrite this file in their output; this checked-in copy is for the server.
window.SURVEY_CONFIG = { backend: 'server' };
