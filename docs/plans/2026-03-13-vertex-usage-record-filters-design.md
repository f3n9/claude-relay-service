# Claude Vertex Usage Record Filters Design

## Goal

Expose `claude-vertex` reconciliation context in existing usage record monitoring so operators can filter and inspect Vertex requests by account type, usage capture state, and request region from both API key and account views.

## Scope

- Touch only existing usage record admin APIs and views.
- Do not add a new log ingestion pipeline.
- Do not broaden behavior for non-Vertex providers beyond harmless generic field passthrough.

## Chosen Approach

Add the reconciliation-related fields already present in stored usage records and route metadata to:

1. `src/routes/admin/usageStats.js`
   - API key usage records endpoint
   - account usage records endpoint
2. `web/admin-spa/src/views/ApiKeyUsageRecordsView.vue`
3. `web/admin-spa/src/views/AccountUsageRecordsView.vue`
4. `web/admin-spa/src/components/apikeys/RecordDetailModal.vue`

## Data Model

Usage record payloads already persist or can derive:
- `accountType`
- `usageCaptureState`
- `requestRegion`

The admin usage-record endpoints should:
- echo these fields on each record
- support query filters for `accountType`, `usageCaptureState`, `requestRegion`
- publish filter option lists in `availableFilters`

## UI Behavior

Both usage record views get three extra filters:
- account type
- usage capture state
- request region

The record detail modal shows:
- account type
- usage capture state
- request region

The fields remain useful for all records, but the operator intent is specifically `claude-vertex` reconciliation.

## Testing

Backend first:
- add failing route tests for both usage-record endpoints
- verify filter application and response field exposure

Frontend:
- keep implementation minimal and compatible with existing request parameter builders
- no new frontend test stack unless one already exists locally for these views
