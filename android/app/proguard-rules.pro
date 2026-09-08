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

# Line numbers in a crash report from a released build are worth more than the
# few bytes they cost.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
