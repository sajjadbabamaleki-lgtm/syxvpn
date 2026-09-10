# R8 rules for the release build.
#
# The app's own code has nothing R8 must be told about: it reads JSON through
# kotlinx.serialization's JsonObject rather than reflected @Serializable
# classes, and nothing is looked up by name. The libraries it uses ship their
# own consumer rules. What is left is noise suppression and one real keep.

# kotlinx.serialization keeps its runtime happy without reflection on our side,
# but its own internals reference classes that are not always present.
-dontwarn kotlinx.serialization.**

# Tink, under androidx.security-crypto, resolves key managers by name. Its own
# consumer rules cover this; the -dontwarn is for the optional GCP/AWS KMS
# integrations that this app does not include.
-dontwarn com.google.api.client.**
-dontwarn com.google.crypto.tink.integration.**
-dontwarn org.joda.time.**

# The VpnService is started by the system from the manifest.
-keep class net.jordanvpn.app.vpn.JordanVpnService { *; }

# libXray is a gomobile binding, and gomobile's Go side calls back into Java
# through JNI — GetMethodID with a literal name and signature. R8 cannot see a
# call that is a string inside a native library, so left to itself it is free to
# rename or remove exactly the methods Go is about to look up.
#
# The one that matters is DialerController.protectFd: it is how every socket the
# core opens gets handed to VpnService.protect(). If Go cannot find it, the
# gateway connection is routed into the TUN that is carrying it — a loop that
# never passes a packet, in a build that starts, says "connected", and moves no
# traffic. Debug builds are not minified, so this fails only in release.
-keep class libXray.** { *; }
-keep interface libXray.** { *; }
-keep class go.** { *; }
-keepclassmembers class * implements libXray.DialerController { *; }
-keepclassmembers class * implements libXray.ListenerController { *; }

# The general form of the same problem: anything the JNI side resolves by name.
-keepclasseswithmembernames class * {
    native <methods>;
}

# Line numbers in a crash report from a released build are worth more than the
# few bytes they cost.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
