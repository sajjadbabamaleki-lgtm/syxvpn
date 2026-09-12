# What goes here

`syxvpn.apk`, and nothing else.

The site's download buttons point at `/download/syxvpn.apk`, and the web
container mounts this directory at that path read-only. Copying a new build in
publishes it — there is no rebuild and no deploy, because a file copy should not
need one.

The APK itself is deliberately not in git: it is a hundred megabytes of build
output, it changes on every release, and git keeps every version of it forever.
Take it from the `app-latest` release on GitHub, or from the Actions run that
built it, and copy it in:

    scp syxvpn-arm64-v8a-release.apk root@<host>:/opt/cvpn/download/syxvpn.apk

The universal APK is the one to publish if the button has to work on any phone
at all; the arm64 one is smaller and covers everything sold in the last few
years.
