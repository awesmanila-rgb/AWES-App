package com.awes.app.core.data

import com.awes.app.core.model.*

interface AppRepository {
    suspend fun seedIfNeeded()
    suspend fun loginAdmin(password: String): Result<Session>
    suspend fun loginTechnician(userId: String, password: String): Result<Session>
    suspend fun logout()
    suspend fun currentSession(): Session?

    suspend fun users(): List<User>
    suspend fun addTechnician(name: String, password: String): Result<User>
    suspend fun updateTechnician(user: User, newPassword: String?): Result<Unit>
    suspend fun deleteTechnician(id: String): Result<Unit>

    suspend fun saveReport(report: ServiceReport): Result<Unit>
    suspend fun reports(): List<ServiceReport>
    suspend fun nextSrNo(date: String): String

    suspend fun dtrForUser(userId: String, date: String): DtrRecord?
    suspend fun saveDtr(record: DtrRecord): Result<Unit>
    suspend fun deviceLock(userId: String): String?
    suspend fun setDeviceLock(userId: String, deviceId: String): Result<Unit>
    suspend fun clearDeviceLock(userId: String): Result<Unit>

    suspend fun leaveRequests(userId: String? = null): List<LeaveRequest>
    suspend fun saveLeave(request: LeaveRequest): Result<Unit>
    suspend fun cashAdvances(userId: String? = null): List<CashAdvanceRequest>
    suspend fun saveCashAdvance(request: CashAdvanceRequest): Result<Unit>
}
