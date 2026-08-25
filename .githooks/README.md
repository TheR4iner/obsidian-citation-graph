# Git hooks

Enabled by `npm install` (the `prepare` script points `core.hooksPath` here), or
manually:

```bash
git config core.hooksPath .githooks
```

- **pre-push** refuses to push content matching the private-content patterns to
  any remote not explicitly trusted. It fails closed: an unrecognised remote is
  untrusted, so adding a remote or repointing a URL cannot quietly disable it.
- **pre-commit** raises the same objection earlier, when private content is
  staged on a branch tracking an untrusted remote.

Both read `forbidden-paths.txt` and `forbidden-text.txt` (one extended regex per
line). A clone without those files has nothing to enforce and both hooks are
no-ops, which is the normal case. Where they are expected, set

```bash
git config citationgraph.guardrequired true
```

and a missing pattern file becomes a loud failure instead of a quiet pass.

Trust a remote by URL substring, not by name, since a name can be repointed:

```bash
git config --add citationgraph.trustedremoteurl 'github.com:me/my-fork'
```
