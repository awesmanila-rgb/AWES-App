package com.awes.app.feature.admin

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.awes.app.core.AppViewModel
import com.awes.app.core.model.User
import kotlinx.coroutines.launch

@Composable
fun AdminScreen(vm:AppViewModel,onBack:()->Unit){
    var users by remember{mutableStateOf(emptyList<User>())};var name by remember{mutableStateOf("")};var password by remember{mutableStateOf("")};var message by remember{mutableStateOf("")};val scope=rememberCoroutineScope()
    LaunchedEffect(Unit){users=vm.users()}
    Column(Modifier.fillMaxSize().padding(16.dp)){
        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text("Administration",style=MaterialTheme.typography.headlineSmall);TextButton(onClick=onBack){Text("Back")}}
        Text("Manage Technicians",style=MaterialTheme.typography.titleMedium)
        users.forEach{u->
            Card(Modifier.fillMaxWidth().padding(vertical=4.dp)){Column(Modifier.padding(10.dp)){
                Text(u.name);Text(if(u.active)"Active" else "Deactivated",color=MaterialTheme.colorScheme.onSurfaceVariant)
                Row{Button(onClick={scope.launch{vm.updateUser(u.copy(active=!u.active),null);users=vm.users()}}){Text(if(u.active)"Deactivate" else "Reactivate")}
                    Spacer(Modifier.width(6.dp));OutlinedButton(onClick={scope.launch{vm.deleteUser(u.id);users=vm.users()}}){Text("Remove")}}
            }}
        }
        Spacer(Modifier.height(12.dp));Text("Add Technician",style=MaterialTheme.typography.titleMedium)
        OutlinedTextField(name,{name=it},label={Text("Full Name")},modifier=Modifier.fillMaxWidth())
        OutlinedTextField(password,{password=it},label={Text("Password")},modifier=Modifier.fillMaxWidth())
        Button(onClick={scope.launch{val r=vm.addTech(name,password);message=r.exceptionOrNull()?.message?:"Technician added";users=vm.users();if(r.isSuccess){name="";password=""}}},modifier=Modifier.fillMaxWidth()){Text("Add Technician")}
        Text(message,color=MaterialTheme.colorScheme.error)
    }
}
