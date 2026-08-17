package com.awes.app.feature.cashadvance

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.awes.app.core.AppViewModel
import com.awes.app.core.model.*
import kotlinx.coroutines.launch
import java.util.UUID

@Composable
fun CashAdvanceScreen(vm:AppViewModel,onBack:()->Unit){
    val session=vm.session.collectAsState().value ?: return
    var amount by remember{mutableStateOf("")};var purpose by remember{mutableStateOf("")};var project by remember{mutableStateOf("")};var needed by remember{mutableStateOf("")};var liquidation by remember{mutableStateOf("")};var mode by remember{mutableStateOf("")};var status by remember{mutableStateOf("")}
    var list by remember{mutableStateOf(emptyList<CashAdvanceRequest>())};val scope=rememberCoroutineScope()
    LaunchedEffect(Unit){list=vm.cash(if(session.user.role==UserRole.ADMIN)null else session.user.id)}
    Column(Modifier.fillMaxSize().padding(16.dp)){
        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text("Cash Advance",style=MaterialTheme.typography.headlineSmall);TextButton(onClick=onBack){Text("Back")}}
        if(session.user.role==UserRole.TECHNICIAN){
            Field("Amount (₱)",amount,{amount=it});Field("Purpose",purpose,{purpose=it},true);Field("Project",project,{project=it});Field("Date Needed",needed,{needed=it});Field("Liquidation Date",liquidation,{liquidation=it});Field("Payment Mode",mode,{mode=it})
            Button(onClick={scope.launch{
                val n=amount.toDoubleOrNull()
                if(n==null||n<=0||purpose.isBlank()||needed.isBlank()){status="Complete required fields";return@launch}
                vm.saveCash(CashAdvanceRequest(UUID.randomUUID().toString(),session.user.id,session.user.name,n,purpose,project,needed,liquidation.ifBlank{null},mode))
                list=vm.cash(session.user.id);status="Cash advance submitted"
            }},modifier=Modifier.fillMaxWidth()){Text("Submit Request")}
            Text(status)
        } else {
            Text("Admin review queue")
            list.forEach{r->Card(Modifier.fillMaxWidth().padding(vertical=4.dp)){Column(Modifier.padding(10.dp)){Text("${r.userName} — ₱${"%.2f".format(r.amount)}");Text(r.purpose);Text(r.status)}}}
        }
    }
}
@Composable private fun Field(l:String,v:String,c:(String)->Unit,m:Boolean=false){OutlinedTextField(v,c,label={Text(l)},modifier=Modifier.fillMaxWidth().padding(bottom=7.dp),minLines=if(m)2 else 1)}
