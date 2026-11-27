package send

import (
	"os"
	"testing"
)

func TestDetectClaudeSurvey(t *testing.T) {
	corpus, err := os.ReadFile("../tmux/testdata/status_corpus/claude-local-huawei_cfe7d2c4.txt")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, pane string
		options    int
	}{
		{"corpus", string(corpus), 4},
		{"unsure", "● How is Claude doing this session? (optional)\n  1: Bad    2: Fine   3: Good   4: Unsure 0: Dismiss\n❯ \n", 5},
		{"draft typed", "● How is Claude doing this session? (optional)\n  1: Bad    2: Fine   3: Good   0: Dismiss\n────────\n❯ hello\n────────\n", 0},
		{"scrolled away", "● How is Claude doing this session? (optional)\n  1: Bad    2: Fine   3: Good   0: Dismiss\n" + "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\nq\nr\ns\nt\n", 0},
		{"no survey", "⏺ Done.\n❯ \n", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := detectClaudeSurvey(tc.pane)
			if tc.options == 0 {
				if got != nil {
					t.Fatalf("detected %+v", got)
				}
				return
			}
			if got == nil || len(got.Options) != tc.options || got.Options[len(got.Options)-1].Choice != "0" || got.Options[0].Label != "Bad" {
				t.Fatalf("got %+v", got)
			}
		})
	}
}
