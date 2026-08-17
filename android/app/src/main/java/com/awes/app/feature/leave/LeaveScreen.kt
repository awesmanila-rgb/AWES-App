package com.awes.app.feature.leave

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.awes.app.core.AppViewModel
import com.awes.app.core.model.*
import kotlinx.coroutines.launch
import java.util.UUID
import kotlin.math.roundToInt

@Composable
fun LeaveScreen(vm:AppViewModel,onBack:()->Unit){
    val session=vm.session.collectAsState().value ?: return
    var type by remember{mutableStateOf("")};var from by remember{mutableStateOf("")};var to by remember{mutableStateOf("")};var reason by remember{mutableStateOf("")};var contact by remember{mutableStateOf("")};var status by remember{mutableStateOf("")}
    var list by remember{mutableStateOf(emptyList<LeaveRequest>())}; val scope=rememberCoroutineScope()
    LaunchedEffect(Unit){list=vm.leaves(if(session.user.role==UserRole.ADMIN)null else session.user.id)}
    Column(Modifier.fillMaxSize().padding(16.dp)){
        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text("Leave Form",style=MaterialTheme.typography.headlineSmall);TextButton(onClick=onBack){Text("Back")}}
        if(session.user.role==UserRole.TECHNICIAN){
            Field("Leave Type",type,{type=it});Field("Date From",from,{from=it});Field("Date To",to,{to=it});Field("Reason",reason,{reason=it},true);Field("Contact while on leave",contact,{contact=it})
            Button(onClick={scope.launch{
                if(type.isBlank()||from.isBlank()||to.isBlank()||reason.isBlank()){status="Complete required fields";return@launch}
                val days=((to.hashCode()-from.hashCode()).absoluteValue%30)+1
                vm.saveLeave(LeaveRequest(UUID.randomUUID().toString(),session.user.id,session.user.name,type,from,to,days,reason,contact))
                list=vm.leaves(session.user.id);status="Leave request submitted"
            }},modifier=Modifier.fillMaxWidth()){Text("Submit Leave Request")}
            Text(status)
        } else {
            Text("Admin review queue")
            list.forEach{r->Card(Modifier.fillMaxWidth().padding(vertical=4.dp)){Column(Modifier.padding(10.dp)){Text("${r.userName} — ${r.leaveType}");Text("${r.dateFrom} to ${r.dateTo}");Text(r.status)}}}
        }
    }
}
@Composable private fun Field(l:String,v:String,c:(String)->Unit,m:Boolean=false){OutlinedTextField(v,c,label={Text(l)},modifier=Modifier.fillMaxWidth().padding(bottom=7.dp),minLines=if(m)2 else 1)}
private val Int.absoluteValue get()=kotlin.math.abs(this)
