import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

/**
 * Release signing.
 *
 * The keystore never enters the repository. Put its details in
 * `android/keystore.properties` (git-ignored):
 *
 *     storeFile=/absolute/path/jordan-release.jks
 *     storePassword=...
 *     keyAlias=jordan
 *     keyPassword=...
 *
 * or set JORDAN_KEYSTORE / JORDAN_KEYSTORE_PASSWORD / JORDAN_KEY_ALIAS /
 * JORDAN_KEY_PASSWORD in the environment for a CI build. With neither present
 * the release build still runs and is simply left unsigned, so a debug build
 * never fails because of a missing key.
 */
val keystoreProperties = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
val keystorePath: String? = (keystoreProperties.getProperty("storeFile")
    ?: System.getenv("JORDAN_KEYSTORE"))?.takeIf { it.isNotBlank() }

android {
    namespace = "net.jordanvpn.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "net.jordanvpn.app"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        // Where the app talks to the control plane. Override per build.
        buildConfigField("String", "CONTROL_PLANE_URL", "\"https://control.example.net\"")

        // Whether the Premium tab may open a USDT order inside the app.
        //
        // True is right for a directly distributed APK. A Google Play build must
        // set it to false: Play's payments policy does not allow selling digital
        // goods for crypto in-app, and the tab then lists the plans read-only and
        // sends the customer to the web storefront to pay.
        buildConfigField("boolean", "IN_APP_ORDERS", "true")
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = keystoreProperties.getProperty("storePassword")
                    ?: System.getenv("JORDAN_KEYSTORE_PASSWORD")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                    ?: System.getenv("JORDAN_KEY_ALIAS")
                keyPassword = keystoreProperties.getProperty("keyPassword")
                    ?: System.getenv("JORDAN_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    // The Xray runtime is NOT vendored in this repository. Drop the AAR built
    // from https://github.com/XTLS/libXray into app/libs and enable this line.
    // implementation(name = "libXray", ext = "aar")

    debugImplementation("androidx.compose.ui:ui-tooling")
}
