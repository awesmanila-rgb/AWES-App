package com.awes.app.core

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.awes.app.core.data.LocalRepository
import com.awes.app.core.data.AppRepository
import com.awes.app.core.model.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val repo: AppRepository = LocalRepository(app)
    private val _session = MutableStateFlow<Session?>(null)
    val session: StateFlow<Session?> = _session
    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message

    init { viewModelScope.launch { repo.seedIfNeeded() } }

    fun loginAdmin(password: String, done: (Boolean) -> Unit) = viewModelScope.launch {
        val r = repo.loginAdmin(password)
        if (r.isSuccess) { _session.value = r.getOrNull(); done(true) }
        else { _message.value = r.exceptionOrNull()?.message; done(false) }
    }

    fun loginTech(id: String, password: String, done: (Boolean) -> Unit) = viewModelScope.launch {
        val r = repo.loginTechnician(id, password)
        if (r.isSuccess) { _session.value = r.getOrNull(); done(true) }
        else { _message.value = r.exceptionOrNull()?.message; done(false) }
    }

    fun logout() { _session.value = null; viewModelScope.launch { repo.logout() } }
    suspend fun users() = repo.users()
    suspend fun addTech(name: String, password: String) = repo.addTechnician(name, password)
    suspend fun updateUser(user: User, password: String?) = repo.updateTechnician(user, password)
    suspend fun deleteUser(id: String) = repo.deleteTechnician(id)
    suspend fun saveReport(r: ServiceReport) = repo.saveReport(r)
    suspend fun reports() = repo.reports()
    suspend fun nextSrNo(date: String) = repo.nextSrNo(date)
    suspend fun dtr(userId: String, date: String) = repo.dtrForUser(userId, date)
    suspend fun saveDtr(r: DtrRecord) = repo.saveDtr(r)
    suspend fun deviceLock(id: String) = repo.deviceLock(id)
    suspend fun setDeviceLock(id: String, device: String) = repo.setDeviceLock(id, device)
    suspend fun clearDeviceLock(id: String) = repo.clearDeviceLock(id)
    suspend fun leaves(id: String? = null) = repo.leaveRequests(id)
    suspend fun saveLeave(r: LeaveRequest) = repo.saveLeave(r)
    suspend fun cash(id: String? = null) = repo.cashAdvances(id)
    suspend fun saveCash(r: CashAdvanceRequest) = repo.saveCashAdvance(r)
    fun clearMessage() { _message.value = null }
}
