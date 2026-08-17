package com.awes.app.core.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Green = Color(0xFF1F7A50)
private val DarkGreen = Color(0xFF154D34)

@Composable
fun AwesTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = Green,
            onPrimary = Color.White,
            secondary = DarkGreen,
            background = Color(0xFFF3F5F2),
            surface = Color.White
        ),
        content = content
    )
}
