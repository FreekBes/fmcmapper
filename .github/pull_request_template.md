<!--
Thanks for contributing! Fill in the sections that apply and delete the rest.
Most PRs add support for a new Minecraft version — see the section near the
bottom for that. See CONTRIBUTING.md for the full guide.
-->

## Type of change

- [ ] New Minecraft version support
- [ ] Bug fix (rendering, tiling, viewer, …)
- [ ] New feature / improvement
- [ ] Documentation
- [ ] Other (CI, refactor, …)

## Summary

<!-- What does this PR change, and why? -->

## Checklist

- [ ] I built and ran the affected component and tested my change (see [CONTRIBUTING.md](../CONTRIBUTING.md)).
- [ ] The code, the added functionality, and this description are clear (AI-assisted work is fine — just review it and stand behind it).

---

## Adding a new Minecraft version

<!-- Delete this whole section if your PR is NOT a version bump. -->

**Target Minecraft version:**
**DataVersion:**

**Mod code changes** <!-- API renames you had to make in MapColorDumpMod, or "none". -->

- [ ] Updated `minecraft_version`, `loader_version`, `fabric_api_version`, and
      `loom_version` in `MapColorDumpMod/gradle.properties` (from <https://fabricmc.net/develop>).
- [ ] The mod builds (`docker compose -f docker-compose.dump.yml build`).
- [ ] Regenerated and committed `assets/map_colors.json` + `assets/biome_colors.json`.
- [ ] Updated `TARGET_VERSION` and `TARGET_DATA_VERSION` in `src/buildtiles.ts`.
- [ ] Updated the `TINTS` table in `src/chunkmap.ts` for any new biome-tinted
      blocks — or N/A.
- [ ] Tested rendering a world of this version: **no** version-mismatch warning,
      and colours (grass/foliage/water/leaves) look right.

---

## Screenshots (optional)

<!-- Especially helpful for rendering changes / version bumps. -->

## Notes

<!-- Anything reviewers should know. -->
