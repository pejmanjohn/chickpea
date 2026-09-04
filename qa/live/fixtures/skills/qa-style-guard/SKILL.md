---
name: qa-style-guard
description: Return a small structural result for the live verification marker without copying the request.
---

# QA style guard

Use this skill only when the user asks for the QA style guard.

Return one JSON object with these exact keys:

- `style`: `plain`
- `status`: `checked`
- `marker_present`: `true` when the request contains a `qa-` marker

Do not quote or summarize the request. Do not call tools. Do not add other keys.
