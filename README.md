# Filmmakers Europe agency emails

Apify actor that walks the actor search results on www.filmmakers.eu with your logged in session, opens each profile, and saves the agency contact email shown there.

Input: the session cookies as JSON (kept secret by Apify), the search page address, and optional limits.

Output fields: discoveryPage, profileUrl, name, email, contactBlock (agency name and contact person, phone numbers removed).

Progress is stored in a named key value store called filmmakerseu, so a new run skips profiles already checked. Failed or blocked runs save a screenshot and the page source in that same store.

The cookie is never stored in this repository. Paste it into the run input.
