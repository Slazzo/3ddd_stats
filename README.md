# 3ddd_stats
Inject statistical charts for sellers into 3ddd webpage

## How to run
1. Login into your 3ddd profile *(3dsky website currently is not supported)*
2. Open the browser console *(developer tools)*
3. Paste and run the script text into console

## Description
On first run the script will access your invoices pages and new income then will parse and collect all products sales inside each page, this may take some time,
old invoces will be cached to local storage inside the browser for performance reasons and reused for next executions, except for new income page.

The cache data is saved inside *localStorage* with key ***"3ddd_stats_cache"*** and can be deleted at any time using this command.
> localStorage.removeItem("3ddd_stats_cache")

