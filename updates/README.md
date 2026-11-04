# General POS Render update feed

Deploy this repository to Render as a Static Site. The `render.yaml` file publishes the `updates` folder.

After Render assigns an `onrender.com` URL, configure the POS update source as:

`POS_UPDATE_URL=https://your-render-service.onrender.com`

For every future release, update `latest.json` with the new version, the GitHub Release installer URL, its SHA-512 checksum, and release notes. Do not put Cloudflare, GitHub, or Render credentials in this repository.
