package com.awes.app.feature.auth

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.awes.app.core.AppViewModel
import kotlinx.coroutines.launch

@Composable
fun LoginScreen(vm: AppViewModel, onSuccess: () -> Unit) {
    var role by remember { mutableStateOf("Technician") }
    var password by remember { mutableStateOf("") }
    var selectedId by remember { mutableStateOf<String?>(null) }
    var users by remember { mutableStateOf(emptyList<com.awes.app.core.model.User>()) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(role) {
        if (role == "Technician") users = vm.users()
    }

    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center) {
        Text("AW Engineering Services", style=MaterialTheme.typography.headlineSmall)
        Text("Field digital application", color=MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(20.dp))

        Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            FilterChip(selected=role=="Technician", onClick={role="Technician";password="";selectedId=null}, label={Text("Technician")})
            FilterChip(selected=role=="Admin", onClick={role="Admin";password="";selectedId=null}, label={Text("Admin")})
        }
        Spacer(Modifier.height(12.dp))

        if (role == "Technician") {
            if (selectedId == null) {
                Text("Select your name", style=MaterialTheme.typography.labelLarge)
                Spacer(Modifier.height(6.dp))
                users.filter { it.active }.forEach { u ->
                    OutlinedButton(onClick={selectedId=u.id}, modifier=Modifier.fillMaxWidth()) { Text(u.name) }
                }
                if (users.none { it.active }) Text("No active technician accounts. Ask an admin to add one.")
            } else {
                val selected = users.firstOrNull { it.id == selectedId }
                Text("Signing in as ${selected?.name ?: ""}")
                TextButton(onClick={selectedId=null}) { Text("Change technician") }
                OutlinedTextField(password,{password=it},label={Text("Password")},modifier=Modifier.fillMaxWidth())
                Spacer(Modifier.height(12.dp))
                Button(onClick={scope.launch {
                    vm.loginTech(selectedId!!,password,onSuccess)
                }},modifier=Modifier.fillMaxWidth()){Text("Sign In")}
            }
        } else {
            OutlinedTextField(password,{password=it},label={Text("Admin password")},modifier=Modifier.fillMaxWidth())
            Spacer(Modifier.height(12.dp))
            Button(onClick={vm.loginAdmin(password,onSuccess)},modifier=Modifier.fillMaxWidth()){Text("Sign In")}
        }
    }
}
