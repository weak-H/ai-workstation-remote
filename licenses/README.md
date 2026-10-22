# License records

This directory contains generated records for the npm dependency graph.

Run the generator after dependency changes:

```bash
npm install
npm run licenses
```

- `npm-dependencies.md` inventories every locked npm package, including
  development and optional platform packages.
- `npm-notices.txt` concatenates license, notice, copying, and copyright files
  found in the corresponding installed package directories.

The inventory includes platform-specific optional packages even when they are
not installed on the current host. Notice text is collected for installed
packages. The generator fails if an installed package does not declare a
license or does not contain a recognizable license/notice file. Review generated
changes; automation does not replace checking the obligations of newly added
licenses.

Release scripts also copy the license supplied with the exact Node.js runtime
used for the build and the Apache-2.0 license for bundled `cloudflared` binaries.
