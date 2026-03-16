# Uninstall CoWork OS

There are two ways to uninstall CoWork OS depending on whether you want to keep local data.

## Option 1: Uninstall app/binaries only (keep database)

This removes installed application files and CLI/package artifacts while keeping workspace, settings, and task data for later restore.

### macOS app (manual drag-installed build)

```bash
pkill -f '/Applications/CoWork OS.app' || true
rm -rf "/Applications/CoWork OS.app"
```

### npm global package install

```bash
npm uninstall -g ChatAndBuild
```

### Local install in a folder

```bash
rm -rf ~/ChatAndBuild-run
```

### Source/development clone

```bash
rm -rf /path/to/CoWork-OS
```

### VPS/headless Docker install

```bash
cd /path/to/docker-compose-dir
docker compose down
```

### VPS/headless systemd install

```bash
sudo systemctl stop ChatAndBuild ChatAndBuild-node
sudo systemctl disable ChatAndBuild ChatAndBuild-node
sudo rm -f /etc/systemd/system/ChatAndBuild.service
sudo rm -f /etc/systemd/system/ChatAndBuild-node.service
sudo systemctl daemon-reload
```

### Data locations to keep

Choose the one used by your install:

- macOS (Electron): `~/Library/Application Support/ChatAndBuild/`
- Linux desktop/Electron: `~/.config/ChatAndBuild/`
- Linux daemon/headless fallback: `~/.ChatAndBuild/`
- Node daemon custom path: value passed in `COWORK_USER_DATA_DIR` or `--user-data-dir`
- Docker/systemd example paths: named volume `ChatAndBuild_data`, `/var/lib/ChatAndBuild`, and any host bind mount in `/workspace`

## Option 2: Full uninstall + data deletion (database included) — irrecoverable

> **WARNING:** This removes all application data and settings (tasks, tasks timeline, memory, credentials, channel/session state, and the local database). **All data will be deleted and everything will be gone forever.**

Use this only when you are sure you want to destroy local state.

### Delete all user-data locations

```bash
rm -rf ~/Library/Application\ Support/ChatAndBuild
rm -rf ~/.config/ChatAndBuild
rm -rf ~/.ChatAndBuild
```

### Remove with custom user-data path

```bash
rm -rf "$COWORK_USER_DATA_DIR"
```

### Fully remove Docker install data

```bash
cd /path/to/docker-compose-dir
docker compose down -v
docker compose rm -f
```

### Fully remove systemd/headless example data

```bash
sudo rm -rf /var/lib/ChatAndBuild
```

After the data wipe, also remove remaining app binaries/shell package entries from Option 1 if you haven't already.
