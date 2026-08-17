package com.awes.app.core.security

import android.content.Context
import android.provider.Settings
import java.security.MessageDigest
import java.security.SecureRandom
import android.util.Base64

object DeviceIdentity {
    fun id(context: Context): String =
        Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
            ?: "unknown-device"
}

object PasswordHasher {
    fun hash(password: String, salt: ByteArray = randomSalt()): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val bytes = digest.digest(salt + password.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(salt, Base64.NO_WRAP) + ":" +
                Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    fun verify(password: String, stored: String): Boolean {
        return try {
            val parts = stored.split(":")
            if (parts.size != 2) return false
            val salt = Base64.decode(parts[0], Base64.NO_WRAP)
            hash(password, salt).substringAfter(":") == parts[1]
        } catch (_: Exception) { false }
    }

    private fun randomSalt(): ByteArray = ByteArray(16).also { SecureRandom().nextBytes(it) }
}
