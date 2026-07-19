# Published v5.0.0 declaration fixture

These files are byte-for-byte copies from the immutable npm tarball for
`@autonome-research/thread-phase@5.0.0`; they are not reconstructed from a git
commit or from the current source tree.

The fixture retains the published package manifest and all 130 declaration and
declaration-map files from the tarball. Tarball `dist/` entries are retained
byte-for-byte under `published/` because repository-wide ignore rules exclude
build directories named `dist`. `published-declarations.sha256` covers the
complete retained declaration tree. `provenance.json` records the registry URL
and integrity, tarball hashes, package dimensions, retrieval commands, key-file
hashes, and the declaration-manifest hash.

To verify a newly retrieved tarball:

```sh
npm pack @autonome-research/thread-phase@5.0.0 --json --ignore-scripts
sha256sum autonome-research-thread-phase-5.0.0.tgz
sha512sum autonome-research-thread-phase-5.0.0.tgz
tar -xzf autonome-research-thread-phase-5.0.0.tgz
sha256sum package/package.json
cd package/dist
find . -type f \( -name '*.d.ts' -o -name '*.d.ts.map' \) -print0 \
  | sort -z | xargs -0 sha256sum
```

Expected tarball identifiers:

- npm/SHA-1: `b65bef53d5d36726cb37b98b575108305aff9a4d`
- npm integrity: `sha512-Utn4dMqH1GWZRAQQDbVy730M6jWHBpXl6YvmMXEASdZvoNPm7MZ+agGbLVa1xQwl3ombJ+8znpxgfg06B2bFdA==`
- SHA-256: `d559ebd7eb68f25781a4ad46ed02d484870093d07832ec4ad85aad0eb92cee90`

The published declarations establish that v5.0.0 already required atomic,
owner-aware lifecycle methods on `JobStore`, including boolean-returning
`setRunning`, `setCompleted`, and `setFailed`, terminal finalization methods,
cancellation/abandonment methods, owner-aware `heartbeat`, and
`enableHeartbeat`. They also establish that `claimRunning`, `heartbeatOwned`,
`OwnedJobStoreCapabilities`, and `OwnedHeartbeatJobStoreCapabilities` were not
published by the root, session, or `SqliteJobStore` declaration surfaces.
