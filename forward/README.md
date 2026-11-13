# pine has moved to `@pmndre/pine`

This package now only forwards to [`@pmndre/pine`](https://www.npmjs.com/package/@pmndre/pine): it depends on it and starts it, so an existing `pine` command keeps working.

To switch to the new package:

```sh
npm uninstall -g @pmndrs/pine && npm install -g @pmndre/pine
```

New installs should use `npm install -g @pmndre/pine` directly.

Source and documentation: https://github.com/pmndrs/pine
