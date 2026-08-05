---
name: Wouter wildcard routing pattern
description: The correct wildcard route pattern for multi-segment paths in wouter v3 + regexparam v3
---

In wouter v3 with regexparam v3, `/:rest*` generates `/^\/([^/]+?)\/?$/i` which only matches **single-segment** paths (e.g. `/dashboard`, `/projects`). It does NOT match `/projects/4`, `/clients/123`, etc.

To catch all paths in the outer Switch (catch-all for ProtectedRoutes), use `*` as the path:
```tsx
<Route path="*" component={ProtectedRoutes} />
```

`*` generates `/^\/(.*)\/?$/i` which matches any path including multi-segment ones.

**Why:** regexparam v3 changed wildcard behavior vs v2. `/:rest*` is a named param with zero-or-more quantifier, but the quantifier applies to the capture group's character class (non-slash chars), not to slash-separated segments.

**How to apply:** Any time a wouter v3 Switch needs a catch-all fallback route that handles paths like `/foo/bar`, use `path="*"`, not `path="/:rest*"`.
