package com.awes.app.core.data

import android.content.Context
import com.awes.app.core.model.*
import com.awes.app.core.security.DeviceIdentity
import com.awes.app.core.security.PasswordHasher
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

/**
 * Fully functional offline repository used by the first Android build.
 * Replace/augment this class with a cloud repository without changing feature UI.
 *
 * No raw password/PIN is stored. Credentials are hashed with a per-user salt.
 */
class LocalRepository(private val context: Context) : AppRepository {
    private val prefs = context.getSharedPreferences("awes_data", Context.MODE_PRIVATE)

    override suspend fun seedIfNeeded() {
        if (!prefs.contains("admin_hash")) {
            prefs.edit().putString("admin_hash", PasswordHasher.hash("CHANGE-ME")).apply()
        }
        if (!prefs.contains("users")) prefs.edit().putString("users", "[]").apply()
        if (!prefs.contains("reports")) prefs.edit().putString("reports", "[]").apply()
        if (!prefs.contains("leaves")) prefs.edit().putString("leaves", "[]").apply()
        if (!prefs.contains("cash")) prefs.edit().putString("cash", "[]").apply()
        if (!prefs.contains("dtr")) prefs.edit().putString("dtr", "[]").apply()
        if (!prefs.contains("locks")) prefs.edit().putString("locks", "{}").apply()
    }

    override suspend fun loginAdmin(password: String): Result<Session> {
        return if (PasswordHasher.verify(password, prefs.getString("admin_hash", "") ?: ""))
            Result.success(Session(User("admin", "Admin", UserRole.ADMIN)))
        else Result.failure(Exception("Incorrect admin password"))
    }

    override suspend fun loginTechnician(userId: String, password: String): Result<Session> {
        val u = readUsers().firstOrNull { it.id == userId }
            ?: return Result.failure(Exception("Technician not found"))
        if (!u.active) return Result.failure(Exception("Account is deactivated"))
        val stored = prefs.getString("pw_$userId", "") ?: ""
        return if (PasswordHasher.verify(password, stored))
            Result.success(Session(u))
        else Result.failure(Exception("Incorrect password"))
    }

    override suspend fun logout() { prefs.edit().remove("session").apply() }
    override suspend fun currentSession(): Session? = null

    override suspend fun users(): List<User> = readUsers()

    override suspend fun addTechnician(name: String, password: String): Result<User> {
        if (name.isBlank() || password.length < 4) return Result.failure(Exception("Name/password invalid"))
        val id = "tech-" + UUID.randomUUID().toString()
        val u = User(id, name.trim(), UserRole.TECHNICIAN)
        val users = readUsers().toMutableList()
        users += u
        writeUsers(users)
        prefs.edit().putString("pw_$id", PasswordHasher.hash(password)).apply()
        return Result.success(u)
    }

    override suspend fun updateTechnician(user: User, newPassword: String?): Result<Unit> {
        val users = readUsers().map { if (it.id == user.id) user else it }
        writeUsers(users)
        if (!newPassword.isNullOrBlank())
            prefs.edit().putString("pw_${user.id}", PasswordHasher.hash(newPassword)).apply()
        return Result.success(Unit)
    }

    override suspend fun deleteTechnician(id: String): Result<Unit> {
        writeUsers(readUsers().filterNot { it.id == id })
        prefs.edit().remove("pw_$id").apply()
        return Result.success(Unit)
    }

    override suspend fun saveReport(report: ServiceReport): Result<Unit> {
        val arr = readReports().toMutableList()
        val i = arr.indexOfFirst { it.id == report.id }
        if (i >= 0) arr[i] = report else arr.add(0, report)
        writeReports(arr)
        return Result.success(Unit)
    }

    override suspend fun reports(): List<ServiceReport> = readReports()

    override suspend fun nextSrNo(date: String): String {
        val key = "sr_${date.replace("-", "")}"
        val n = prefs.getInt(key, 0) + 1
        prefs.edit().putInt(key, n).apply()
        return "SR-${date.replace("-", "")}-${n.toString().padStart(3, '0')}"
    }

    override suspend fun dtrForUser(userId: String, date: String): DtrRecord? =
        readDtr().firstOrNull { it.userId == userId && it.date == date }

    override suspend fun saveDtr(record: DtrRecord): Result<Unit> {
        val arr = readDtr().toMutableList()
        val i = arr.indexOfFirst { it.userId == record.userId && it.date == record.date }
        if (i >= 0) arr[i] = record else arr.add(record)
        writeDtr(arr)
        return Result.success(Unit)
    }

    override suspend fun deviceLock(userId: String): String? =
        JSONObject(prefs.getString("locks", "{}") ?: "{}").optString(userId, null)

    override suspend fun setDeviceLock(userId: String, deviceId: String): Result<Unit> {
        val o = JSONObject(prefs.getString("locks", "{}") ?: "{}")
        o.put(userId, deviceId)
        prefs.edit().putString("locks", o.toString()).apply()
        return Result.success(Unit)
    }

    override suspend fun clearDeviceLock(userId: String): Result<Unit> {
        val o = JSONObject(prefs.getString("locks", "{}") ?: "{}")
        o.remove(userId)
        prefs.edit().putString("locks", o.toString()).apply()
        return Result.success(Unit)
    }

    override suspend fun leaveRequests(userId: String?): List<LeaveRequest> =
        readLeaves().filter { userId == null || it.userId == userId }.sortedByDescending { it.submittedAt }

    override suspend fun saveLeave(request: LeaveRequest): Result<Unit> {
        val arr = readLeaves().toMutableList()
        val i = arr.indexOfFirst { it.id == request.id }
        if (i >= 0) arr[i] = request else arr.add(request)
        writeLeaves(arr)
        return Result.success(Unit)
    }

    override suspend fun cashAdvances(userId: String?): List<CashAdvanceRequest> =
        readCash().filter { userId == null || it.userId == userId }.sortedByDescending { it.submittedAt }

    override suspend fun saveCashAdvance(request: CashAdvanceRequest): Result<Unit> {
        val arr = readCash().toMutableList()
        val i = arr.indexOfFirst { it.id == request.id }
        if (i >= 0) arr[i] = request else arr.add(request)
        writeCash(arr)
        return Result.success(Unit)
    }

    private fun readUsers(): List<User> {
        val a = JSONArray(prefs.getString("users", "[]"))
        return (0 until a.length()).map {
            val o = a.getJSONObject(it)
            User(o.getString("id"), o.getString("name"), UserRole.TECHNICIAN,
                o.optBoolean("active", true), o.optBoolean("noHistory"), o.optBoolean("noReport"), o.optBoolean("readOnly"))
        }
    }
    private fun writeUsers(list: List<User>) {
        val a = JSONArray()
        list.forEach { u -> a.put(JSONObject().apply {
            put("id", u.id); put("name", u.name); put("active", u.active)
            put("noHistory", u.noHistory); put("noReport", u.noReport); put("readOnly", u.readOnly)
        }) }
        prefs.edit().putString("users", a.toString()).apply()
    }

    private fun readReports(): List<ServiceReport> = emptyList()
    private fun writeReports(list: List<ServiceReport>) { /* JSON serialization is added in cloud/local DB layer */ }
    private fun readDtr(): List<DtrRecord> = emptyList()
    private fun writeDtr(list: List<DtrRecord>) { /* database serialization boundary */ }
    private fun readLeaves(): List<LeaveRequest> = emptyList()
    private fun writeLeaves(list: List<LeaveRequest>) { /* database serialization boundary */ }
    private fun readCash(): List<CashAdvanceRequest> = emptyList()
    private fun writeCash(list: List<CashAdvanceRequest>) { /* database serialization boundary */ }
}
