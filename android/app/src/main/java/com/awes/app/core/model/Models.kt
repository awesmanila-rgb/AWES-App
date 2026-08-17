package com.awes.app.core.model

enum class UserRole { ADMIN, TECHNICIAN }

data class User(
    val id: String,
    val name: String,
    val role: UserRole,
    val active: Boolean = true,
    val noHistory: Boolean = false,
    val noReport: Boolean = false,
    val readOnly: Boolean = false
)

data class Session(val user: User)

data class Material(val details: String = "", val qty: String = "")

data class OperatingData(
    val ampL1: String = "", val ampL2: String = "", val ampL3: String = "",
    val voltL12: String = "", val voltL23: String = "", val voltL31: String = "",
    val suction: String = "", val discharge: String = "",
    val temp: String = "", val airflow: String = ""
)

data class InstallationData(
    val enabled: Boolean = false,
    val pipeSuction: String = "", val pipeDischarge: String = "", val pipeDrain: String = "",
    val lengthRefLine: String = "", val lengthDrain: String = "",
    val wireFeeder: String = "", val wireControl: String = "",
    val breaker: String = "", val insulationRefLine: String = "", val insulationDrain: String = "",
    val riserHeight: String = "", val pTrap: String = "", val bracketType: String = ""
)

data class Signature(val points: List<Pair<Float, Float>> = emptyList())

data class ServiceReport(
    val id: String,
    val srNo: String? = null,
    val date: String,
    val custName: String,
    val custAddress: String = "",
    val contactNo: String = "",
    val contactPerson: String = "",
    val custEmail: String = "",
    val equipType: String = "",
    val modelCU: String = "", val serialCU: String = "",
    val modelFCU: String = "", val serialFCU: String = "",
    val coolCap: String = "", val mountType: String = "",
    val brand: String = "", val refrigerantType: String = "",
    val compressorType: String = "", val equipLocation: String = "",
    val troubleCall: String = "",
    val findings: List<String> = emptyList(),
    val recommendations: List<String> = emptyList(),
    val materials: List<Material> = emptyList(),
    val servicesDone: List<String> = emptyList(),
    val before: OperatingData = OperatingData(),
    val after: OperatingData = OperatingData(),
    val installation: InstallationData = InstallationData(),
    val timeIn: String = "", val timeOut: String = "",
    val remarks: String = "",
    val customerPrintedName: String = "",
    val technicianName: String = "",
    val customerSignature: Signature = Signature(),
    val technicianSignature: Signature = Signature(),
    val completed: Boolean = false,
    val createdAt: Long = System.currentTimeMillis()
)

data class DtrRecord(
    val userId: String,
    val userName: String,
    val date: String,
    val timeIn: Long? = null,
    val timeOut: Long? = null,
    val timeInLat: Double? = null,
    val timeInLng: Double? = null,
    val timeInAccuracy: Float? = null,
    val timeOutLat: Double? = null,
    val timeOutLng: Double? = null,
    val timeOutAccuracy: Float? = null
)

data class LeaveRequest(
    val id: String,
    val userId: String,
    val userName: String,
    val leaveType: String,
    val dateFrom: String,
    val dateTo: String,
    val days: Int,
    val reason: String,
    val contact: String,
    val status: String = "pending",
    val comment: String = "",
    val submittedAt: Long = System.currentTimeMillis(),
    val decidedAt: Long? = null,
    val decidedBy: String? = null
)

data class CashAdvanceRequest(
    val id: String,
    val userId: String,
    val userName: String,
    val amount: Double,
    val purpose: String,
    val project: String,
    val dateNeeded: String,
    val liquidationDate: String?,
    val paymentMode: String,
    val status: String = "pending",
    val comment: String = "",
    val submittedAt: Long = System.currentTimeMillis(),
    val decidedAt: Long? = null,
    val decidedBy: String? = null,
    val disbursed: Boolean = false,
    val dateGiven: String? = null,
    val amountGiven: Double? = null,
    val disbursedAt: Long? = null,
    val disbursedBy: String? = null
)
