pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // libXray / Xray-core AAR is dropped in app/libs (see android/README.md).
        flatDir { dirs("app/libs") }
    }
}

rootProject.name = "SixVPN"
include(":app")
