package com.awes.app.feature.dtr

import android.Manifest
import android.content.pm.PackageManager
import android.location.Location
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.compose.ui.platform.LocalContext
import com.awes.app.core.AppViewModel
import com.awes.app.core.model.DtrRecord
import com.awes.app.core.model.UserRole
import com.awes.app.core.security.DeviceIdentity
import com.google.android.gms.location.LocationServices
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.*

@Composable
fun DtrScreen(vm:AppViewModel,onBack:()->Unit){
    val session=vm.session.collectAsState().value ?: return
    val context=LocalContext.current
    val scope=rememberCoroutineScope()
    val today=SimpleDateFormat("yyyy-MM-dd",Locale.US).format(Date())
    var rec by remember { mutableStateOf<DtrRecord?>(null) }
    var message by remember { mutableStateOf("") }
    val permission=rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()){ }

    LaunchedEffect(Unit){ if(session.user.role==UserRole.TECHNICIAN) rec=vm.dtr(session.user.id,today) }

    fun punch(isIn:Boolean){
        if(ContextCompat.checkSelfPermission(context,Manifest.permission.ACCESS_FINE_LOCATION)!=PackageManager.PERMISSION_GRANTED){
            permission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION,Manifest.permission.ACCESS_COARSE_LOCATION)); return
        }
        scope.launch {
            val lock=vm.deviceLock(session.user.id)
            val dev=DeviceIdentity.id(context)
            if(lock!=null && lock!=dev){ message="This account is registered to another device."; return@launch }
            if(lock==null) vm.setDeviceLock(session.user.id,dev)
            val old=vm.dtr(session.user.id,today)
            val client=LocationServices.getFusedLocationProviderClient(context)
            client.getCurrentLocation(com.google.android.gms.location.Priority.PRIORITY_HIGH_ACCURACY,null)
                .addOnSuccessListener { loc:Location? ->
                    val now=System.currentTimeMillis()
                    rec=if(isIn) DtrRecord(session.user.id,session.user.name,today,now,null,loc?.latitude,loc?.longitude,loc?.accuracy)
                        else old?.copy(timeOut=now,timeOutLat=loc?.latitude,timeOutLng=loc?.longitude,timeOutAccuracy=loc?.accuracy)
                    rec?.let { vm.saveDtr(it) }
                }
        }
    }

    Column(Modifier.fillMaxSize().padding(16.dp)){
        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text("Daily Time Record",style=MaterialTheme.typography.headlineSmall);TextButton(onClick=onBack){Text("Back")}}
        Text(session.user.name)
        Spacer(Modifier.height(12.dp))
        if(session.user.role==UserRole.TECHNICIAN){
            Button(onClick={punch(true)},enabled=rec?.timeIn==null,modifier=Modifier.fillMaxWidth()){Text("🟢 Time In")}
            Button(onClick={punch(false)},enabled=rec?.timeIn!=null && rec?.timeOut==null,modifier=Modifier.fillMaxWidth()){Text("🔴 Time Out")}
            Spacer(Modifier.height(12.dp))
            Text("Time In: "+(rec?.timeIn?.let{Date(it)}?:"—"))
            Text("Time Out: "+(rec?.timeOut?.let{Date(it)}?:"—"))
            Text(message,color=MaterialTheme.colorScheme.error)
        } else {
            Text("Admin DTR viewing will use the same repository, scoped by technician.")
        }
    }
}
