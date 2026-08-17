package com.awes.app.navigation

import androidx.compose.runtime.*
import androidx.navigation.compose.*
import com.awes.app.core.AppViewModel
import com.awes.app.feature.auth.LoginScreen
import com.awes.app.feature.home.HomeScreen
import com.awes.app.feature.servicereport.ServiceReportScreen
import com.awes.app.feature.dtr.DtrScreen
import com.awes.app.feature.leave.LeaveScreen
import com.awes.app.feature.cashadvance.CashAdvanceScreen
import com.awes.app.feature.admin.AdminScreen

object Routes {
    const val LOGIN="login"; const val HOME="home"; const val REPORT="report"
    const val DTR="dtr"; const val LEAVE="leave"; const val CASH="cash"; const val ADMIN="admin"
}

@Composable
fun AwesNavHost(vm: AppViewModel) {
    val nav = rememberNavController()
    val session by vm.session.collectAsState()

    LaunchedEffect(session) {
        if (session == null) nav.navigate(Routes.LOGIN) { popUpTo(0) }
        else nav.navigate(Routes.HOME) { popUpTo(0) }
    }

    NavHost(nav, Routes.LOGIN) {
        composable(Routes.LOGIN) { LoginScreen(vm) { nav.navigate(Routes.HOME) { popUpTo(0) } } }
        composable(Routes.HOME) {
            HomeScreen(session!!.user,
                onReport={nav.navigate(Routes.REPORT)},
                onDtr={nav.navigate(Routes.DTR)},
                onLeave={nav.navigate(Routes.LEAVE)},
                onCash={nav.navigate(Routes.CASH)},
                onAdmin={nav.navigate(Routes.ADMIN)},
                onLogout={vm.logout()})
        }
        composable(Routes.REPORT) { ServiceReportScreen(vm) { nav.popBackStack() } }
        composable(Routes.DTR) { DtrScreen(vm) { nav.popBackStack() } }
        composable(Routes.LEAVE) { LeaveScreen(vm) { nav.popBackStack() } }
        composable(Routes.CASH) { CashAdvanceScreen(vm) { nav.popBackStack() } }
        composable(Routes.ADMIN) { AdminScreen(vm) { nav.popBackStack() } }
    }
}
