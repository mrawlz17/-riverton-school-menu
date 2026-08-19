# Riverton 3rd Grade Menu

A small installable family web app for the Riverton Elementary third-grade menu.

## What it does

- Third-grade / Riverton Elementary only
- Breakfast and Lunch toggle
- Current-day highlight plus simple Monday–Friday list
- Scheduled menu pull every Saturday morning using GitHub Actions
- Force refresh from the app (checks the newest deployed `menu-data.json`)
- Information panel with Current / Out of date status, last pull, last check, next scheduled update, source and app version
- Keeps the last good menu cached on the phone if the network or menu source is unavailable
- Installable on iPhone Home Screen as a standalone PWA

## Source

USD 404's Food Service > Menus page redirects to Health-e Pro / My School Menus organization 1681:

`https://menus.healthepro.com/organizations/1681`

The automated sync uses Playwright because the public menu is JavaScript-driven. It preserves the previous good menu if a scrape fails and writes `sync-debug.json` to make source-site changes diagnosable.

## GitHub setup

1. Put all files in the root of a GitHub repository.
2. Make sure the default branch is named `main`.
3. In GitHub: **Settings > Pages > Build and deployment > Source > Deploy from a branch**.
4. Choose **main** and **/(root)**, then Save.
5. Open **Actions > Update school menu > Run workflow** once. This performs the first menu pull immediately.
6. Open the GitHub Pages URL on the iPhone, tap **Share > Add to Home Screen**.

After that, GitHub Actions runs every Saturday. The app itself also checks the newest published menu every time it opens, and **Force refresh** bypasses browser cache.

## Version

App version: `1.0.0`
