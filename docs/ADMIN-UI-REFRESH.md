# BUILDINTEL Super Admin UI Refresh

This update refreshes the existing `/admin` interface without replacing its API, authentication, role checks, permission model, or workflows.

## Included UI improvements
- Updated BUILDINTEL visual system: navy platform navigation, clear blue action color, neutral workspace surfaces, consistent borders, status chips, and responsive spacing.
- Stronger sidebar hierarchy and active-page state; existing permission-based navigation remains unchanged.
- Sticky workspace header, improved search field, and responsive layout.
- More legible metric cards and dashboard section headings.
- Improved tables, row hover states, filter panels, tabs, status pills, and pagination controls.
- Refined confirmation/step-up dialogs, form fields, and sign-in panel.
- Responsive mobile navigation and filter layout; table-to-card behavior continues to use the existing `labelTables()` behavior.
- Reduced-motion support and visible keyboard focus states.

## Preservation / security
- No admin API endpoints or request payloads were changed.
- No role names, permission keys, authentication behavior, MFA behavior, step-up requirements, audit behavior, or tenant boundaries were changed.
- The page continues to load all records and metrics from `/api/admin/*`; no dashboard metrics were fabricated or hardcoded.
- Features that are not implemented remain disabled or report unavailable status through the existing UI logic.

## Verification performed for this UI-only update
- `node --check public/admin.js`: PASS.
- Focused admin tests (`admin.test.js`, `admin-phase3.test.js`, `admin-phase4.test.js`): 17 passed, 0 failed, 1 skipped.
- The skipped test requires `TEST_DATABASE_URL` for PostgreSQL audit-search integration; it was not available in this environment.
- Full PostgreSQL release verification and full browser end-to-end QA have not been rerun for this UI-only change. Run the repository's complete release verification before deployment.
