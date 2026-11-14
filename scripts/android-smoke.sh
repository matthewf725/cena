#!/usr/bin/env bash
set -euo pipefail

window_file="$(mktemp)"
trap 'rm -f "$window_file"' EXIT

wait_for_label() {
  local application="$1" label="$2"
  for attempt in {1..8}; do
    if adb shell uiautomator dump /sdcard/cena-smoke.xml >/dev/null &&
      adb exec-out cat /sdcard/cena-smoke.xml >"$window_file" &&
      grep -Fq "package=\"$application\"" "$window_file" && grep -Fq "$label" "$window_file"; then
      return 0
    fi
    sleep 2
  done
  echo "Could not find '$label' on $application launch" >&2
  return 1
}

launch() {
  local apk="$1" application="$2"
  adb install -r "$apk"
  adb shell pm clear "$application" >/dev/null
  adb shell am start -W -n "$application/.MainActivity"
}

tap_element() {
  local center x y
  center="$(python3 - "$window_file" "$1" <<'PY'
import re
import sys
import xml.etree.ElementTree as xml

root = xml.parse(sys.argv[1])
label = sys.argv[2]
match = next(node for node in root.iter('node')
             if label in (node.get('text'), node.get('content-desc'))
             and node.get('clickable') == 'true')
x1, y1, x2, y2 = map(int, re.findall(r'\d+', match.attrib['bounds']))
print((x1 + x2) // 2, (y1 + y2) // 2)
PY
)"
  read -r x y <<<"$center"
  adb shell input tap "$x" "$y"
}

launch native/android/customer/build/outputs/apk/debug/customer-debug.apk com.cena.customer
wait_for_label com.cena.customer 'Good food, slower hours. Reserve local meal kits for pickup.'
tap_element Bag
wait_for_label com.cena.customer 'Your bag is empty.'
echo 'Customer launch and empty bag passed'

launch native/android/restaurant/build/outputs/apk/debug/restaurant-debug.apk com.cena.restaurant
wait_for_label com.cena.restaurant 'Staff email'
grep -Fq 'Password' "$window_file"
echo 'Restaurant launch and sign-in form passed'
