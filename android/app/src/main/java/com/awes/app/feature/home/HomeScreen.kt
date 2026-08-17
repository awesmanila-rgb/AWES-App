package com.awes.app.feature.home

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.awes.app.core.model.User
import com.awes.app.core.model.UserRole

@Composable
fun HomeScreen(user: User,onReport:()->Unit,onDtr:()->Unit,onLeave:()->Unit,onCash:()->Unit,onAdmin:()->Unit,onLogout:()->Unit) {
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text(if(user.role==UserRole.ADMIN) "Admin Homepage" else "Technician's Homepage",style=MaterialTheme.typography.headlineSmall)
        Text(user.name,color=MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(18.dp))
        HomeTile("🧾","Service Report",onReport)
        HomeTile("🕒","Daily Time Record",onDtr)
        HomeTile("📅","Leave Form",onLeave)
        HomeTile("💵","Cash Advance",onCash)
        if(user.role==UserRole.ADMIN) HomeTile("⚙️","Administration",onAdmin)
        Spacer(Modifier.weight(1f))
        OutlinedButton(onClick=onLogout,modifier=Modifier.fillMaxWidth()){Text("Logout")}
    }
}
@Composable private fun HomeTile(icon:String,title:String,onClick:()->Unit){
    Button(onClick=onClick,modifier=Modifier.fillMaxWidth().padding(vertical=4.dp)){Text("$icon  $title")}
}
