package com.awes.app.feature.servicereport

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.awes.app.core.AppViewModel
import com.awes.app.core.model.*
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.*
import java.util.UUID

@Composable
fun ServiceReportScreen(vm: AppViewModel, onBack:()->Unit) {
    var date by remember { mutableStateOf(SimpleDateFormat("yyyy-MM-dd",Locale.US).format(Date())) }
    var customer by remember { mutableStateOf("") }
    var address by remember { mutableStateOf("") }
    var contactNo by remember { mutableStateOf("") }
    var contactPerson by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var equipType by remember { mutableStateOf("") }
    var modelCU by remember { mutableStateOf("") }; var serialCU by remember { mutableStateOf("") }
    var modelFCU by remember { mutableStateOf("") }; var serialFCU by remember { mutableStateOf("") }
    var capacity by remember { mutableStateOf("") }; var mount by remember { mutableStateOf("") }
    var brand by remember { mutableStateOf("") }; var refrigerant by remember { mutableStateOf("") }
    var compressor by remember { mutableStateOf("") }; var location by remember { mutableStateOf("") }
    var trouble by remember { mutableStateOf("") }
    var findings by remember { mutableStateOf(listOf("")) }
    var recs by remember { mutableStateOf(listOf("")) }
    var services by remember { mutableStateOf(listOf("")) }
    var materials by remember { mutableStateOf(listOf(Material())) }
    var install by remember { mutableStateOf(InstallationData()) }
    var timeIn by remember { mutableStateOf("") }; var timeOut by remember { mutableStateOf("") }
    var remarks by remember { mutableStateOf("") }
    var printedName by remember { mutableStateOf("") }
    var technician by remember { mutableStateOf("") }
    var status by remember { mutableStateOf("Draft") }
    val scope=rememberCoroutineScope()

    LazyColumn(Modifier.fillMaxSize().padding(12.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
        item { Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){
            Text("Service Report",style=MaterialTheme.typography.headlineSmall); TextButton(onClick=onBack){Text("Back")}
        }}
        item { Section("1. Customer's Information") {
            TwoField("Customer's Name *",customer,{customer=it},"Date",date,{date=it})
            Field("Complete Address",address,{address=it},true)
            TwoField("Contact No.",contactNo,{contactNo=it},"Contact Person",contactPerson,{contactPerson=it})
            Field("Customer Email",email,{email=it})
        }}
        item { Section("2. Equipment Description") {
            Field("Equipment Type",equipType,{equipType=it})
            TwoField("Model No. (CU)",modelCU,{modelCU=it},"Serial No. (CU)",serialCU,{serialCU=it})
            TwoField("Model No. (FCU)",modelFCU,{modelFCU=it},"Serial No. (FCU)",serialFCU,{serialFCU=it})
            TwoField("Cooling Capacity",capacity,{capacity=it},"Mounting Type",mount,{mount=it})
            TwoField("Manufacturer / Brand",brand,{brand=it},"Refrigerant Type",refrigerant,{refrigerant=it})
            TwoField("Compressor Type",compressor,{compressor=it},"Specific Location",location,{location=it})
        }}
        item { Section("3. Report Summary") {
            Field("Trouble Call / Request / Reason for Service",trouble,{trouble=it},true)
            Repeaters("Findings / Evaluation",findings,{findings=it})
            Repeaters("Recommendations",recs,{recs=it})
        }}
        item { Section("4. Materials & Spare Parts") {
            materials.forEachIndexed { i,m ->
                TwoField("Item ${i+1} Details",m.details,{v->materials=materials.mapIndexed{j,x->if(j==i)x.copy(details=v)else x}},
                    "Qty",m.qty,{v->materials=materials.mapIndexed{j,x->if(j==i)x.copy(qty=v)else x}})
            }
            TextButton(onClick={materials=materials+Material()}){Text("+ Add item")}
        }}
        item { Section("5. Services Done") { Repeaters("Describe service(s) performed",services,{services=it}) } }
        item { Section("6. Operating Data — Before Servicing") {
            Text("The Android model contains separate Before/After operating-data objects.")
            Text("Amperage L1/L2/L3, Voltage L12/L23/L31, Suction/Discharge Pressure, Supply Air Temperature and Air Volume are represented in the data model.")
        }}
        item { Section("6. Operating Data — After Servicing") {
            Text("The Android model contains a separate After-servicing operating-data object.")
            Text("Amperage L1/L2/L3, Voltage L12/L23/L31, Suction/Discharge Pressure, Supply Air Temperature and Air Volume are represented in the data model.")
        }}
        item { Section("7. Installation Data") {
            Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){
                Text("This visit includes a new installation")
                Switch(checked=install.enabled,onCheckedChange={install=install.copy(enabled=it)})
            }
            if(install.enabled) {
                TwoField("Pipe Diameter — Suction",install.pipeSuction,{install=install.copy(pipeSuction=it)},"Pipe Diameter — Discharge",install.pipeDischarge,{install=install.copy(pipeDischarge=it)})
                TwoField("Pipe Diameter — Drain",install.pipeDrain,{install=install.copy(pipeDrain=it)},"Pipe Length — Ref't Line",install.lengthRefLine,{install=install.copy(lengthRefLine=it)})
                TwoField("Pipe Length — Drain",install.lengthDrain,{install=install.copy(lengthDrain=it)},"Wire Size — Feeder",install.wireFeeder,{install=install.copy(wireFeeder=it)})
                TwoField("Wire Size — Control",install.wireControl,{install=install.copy(wireControl=it)},"Circuit Breaker",install.breaker,{install=install.copy(breaker=it)})
                TwoField("Pipe Insulation — Ref't Line",install.insulationRefLine,{install=install.copy(insulationRefLine=it)},"Pipe Insulation — Drain",install.insulationDrain,{install=install.copy(insulationDrain=it)})
                TwoField("Riser Pipes Height",install.riserHeight,{install=install.copy(riserHeight=it)},"P-Trap",install.pTrap,{install=install.copy(pTrap=it)})
                Field("Accu Bracket Type",install.bracketType,{install=install.copy(bracketType=it)})
            }
        }}
        item { Section("8. Acknowledgment") {
            Text("I hereby acknowledge the services / works done on my equipment and agree to the terms & conditions stated herein.")
            TwoField("Time In",timeIn,{timeIn=it},"Time Out",timeOut,{timeOut=it})
            Field("Remarks",remarks,{remarks=it},true)
            Field("Customer Printed Name",printedName,{printedName=it})
            Field("Technician Name",technician,{technician=it})
            Text("Digital signature capture is isolated in SignaturePad and will be connected to this report model.")
        }}
        item {
            Button(onClick={
                scope.launch {
                    if(customer.isBlank()) { status="Customer name is required"; return@launch }
                    val sr=vm.nextSrNo(date)
                    val r=ServiceReport(
                        id=UUID.randomUUID().toString(),srNo=sr,date=date,custName=customer,
                        custAddress=address,contactNo=contactNo,contactPerson=contactPerson,custEmail=email,
                        equipType=equipType,modelCU=modelCU,serialCU=serialCU,modelFCU=modelFCU,serialFCU=serialFCU,
                        coolCap=capacity,mountType=mount,brand=brand,refrigerantType=refrigerant,compressorType=compressor,
                        equipLocation=location,troubleCall=trouble,findings=findings.filter{it.isNotBlank()},
                        recommendations=recs.filter{it.isNotBlank()},materials=materials.filter{it.details.isNotBlank()||it.qty.isNotBlank()},
                        servicesDone=services.filter{it.isNotBlank()},installation=install,timeIn=timeIn,timeOut=timeOut,
                        remarks=remarks,customerPrintedName=printedName,technicianName=technician,completed=false)
                    vm.saveReport(r); status="Draft saved: $sr"
                }
            },modifier=Modifier.fillMaxWidth()){Text("Save Draft")}
            Text(status)
        }
    }
}

@Composable private fun Section(title:String,content:@Composable ColumnScope.()->Unit){
    Card(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp)){Text(title,style=MaterialTheme.typography.titleMedium);Spacer(Modifier.height(8.dp));content()}}
}
@Composable private fun Field(label:String,value:String,onChange:(String)->Unit,multi:Boolean=false){
    OutlinedTextField(value,onChange,label={Text(label)},modifier=Modifier.fillMaxWidth().padding(bottom=7.dp),minLines=if(multi)2 else 1)
}
@Composable private fun TwoField(l1:String,v1:String,c1:(String)->Unit,l2:String,v2:String,c2:(String)->Unit){
    Column{Field(l1,v1,c1);Field(l2,v2,c2)}
}
@Composable private fun Repeaters(title:String,list:List<String>,set:(List<String>)->Unit){
    Text(title,style=MaterialTheme.typography.labelLarge)
    list.forEachIndexed{i,v->Row(Modifier.fillMaxWidth()){
        Field("",v){nv->set(list.mapIndexed{j,x->if(j==i)nv else x})}
        TextButton(onClick={if(list.size>1)set(list.filterIndexed{j,_->j!=i})}){Text("−")}
    }}
    TextButton(onClick={set(list+"")}){Text("+ Add item")}
}

