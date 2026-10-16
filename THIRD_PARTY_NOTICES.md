# Resource provenance

This kit assembles original workspace workflows, design guidance, templates, and
card implementations for students. New pipeline resources exclude private source recordings and private reference
screenshots. The original kit's previously published example media and
brand assets remain unchanged; their inclusion does not grant third-party rights.

- HyperFrames: https://github.com/heygen-com/hyperframes (Apache-2.0).
  The hyperframes, hyperframes-cli, hyperframes-registry, and gsap skill packages
  were bundled with the original workspace from the HyperFrames skill ecosystem.
  The upstream Apache license is included in licenses/HYPERFRAMES-LICENSE.
- GSAP is installed from npm; its own license applies. See the license files in
  node_modules/gsap and https://gsap.com/community/standard-license/.
- Story Studio (app/) vendors Mediabunny (https://mediabunny.dev, MPL-2.0) in
  app/vendor/mediabunny.min.mjs, and its AAC encoder extension in
  app/vendor/mediabunny-aac-encoder.min.mjs (MPL-2.0), which embeds a WebAssembly
  build of FFmpeg's AAC encoder (LGPL-2.1-or-later; source at
  https://github.com/Vanilagy/mediabunny and https://ffmpeg.org). The MPL text is
  in app/vendor/MEDIABUNNY-LICENSE.txt. Both files are unmodified upstream builds.
- Story Studio bundles Montserrat and Abril Fatface subsets in app/fonts under the
  SIL Open Font License 1.1; the license texts sit beside the font files.
- Some library styles reference Google Fonts. Font licenses remain with their
  publishers. Install and preserve applicable licenses when localizing fonts.
- Vox, Kallaway, and Infinite are aesthetic reference names. These templates are
  not official brand assets or endorsed by those creators or organizations.

No blanket relicensing of third-party components is implied. See LICENSE for the
MIT permission for the original kit material. Imported pipeline resources
retain the grant in licenses/PIPELINE-USE-PERMISSION.txt. This includes the added
pipeline skills, style library, templates, shared editing tools, and new short-form
workflow. Third-party notices override these grants for their respective assets.

Library names, handles, statistics, and source labels inside cards are illustrative
placeholders. Replace them with your own verified copy before publishing a video.

The three videos in examples/showcase were also explicitly supplied by Nate for
public inclusion as finished-output references. They retain their existing asset
rights; inclusion does not grant rights to third-party brands or embedded media.
