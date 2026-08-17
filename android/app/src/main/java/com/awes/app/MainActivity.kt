package com.awes.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.viewmodel.compose.viewModel
import com.awes.app.core.ui.AwesTheme
import com.awes.app.navigation.AwesNavHost
import com.awes.app.core.AppViewModel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            AwesTheme {
                val vm: AppViewModel = viewModel()
                AwesNavHost(vm)
            }
        }
    }
}
