package de.stephan.evchargelive;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(ObdClassicPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
